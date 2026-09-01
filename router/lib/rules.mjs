// ~/claude-skills/router/lib/rules.mjs
import fs from 'node:fs';
import path from 'node:path';
import { rulesPath } from './paths.mjs';
import { repoRoot } from './git.mjs';

// Top-level keys a local override replaces outright when it names them. `repo_groups` merges per
// group and `rules` per id instead, so an override can carry one private group, or retune one rule,
// without restating the shipped table.
const REPLACE_KEYS = ['docs_only', 'pretooluse_context', 'track_skills', 'allow_skills'];

export const localRulesPath = (file = rulesPath()) => path.join(path.dirname(file), 'skill-rules.local.json');

// The shipped table names no repositories: the machine's own names live beside it in a gitignored
// `skill-rules.local.json`. Base-only stays a valid table, so a local that will not parse costs the
// override and never the rules — but it is returned as an error, because a silent one would ungate
// every repo the local file is the only record of.
function readLocal(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') return { local: null, error: `${file}: ${e.message}` };
    // ENOENT through a symlink is a local file that IS there and cannot be read (a moved target),
    // which reads as "no override" unless something separates it from a plain absence. lstat does.
    try { fs.lstatSync(file); } catch { return { local: null, error: null }; }
    return { local: null, error: `${file}: broken symlink` };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
    return { local: parsed, error: null };
  } catch (e) { return { local: null, error: `${file}: ${e.message}` }; }
}

function merge(base, local) {
  const out = { ...base };
  for (const k of REPLACE_KEYS) if (k in local) out[k] = local[k];
  if (local.repo_groups && typeof local.repo_groups === 'object' && !Array.isArray(local.repo_groups)) {
    out.repo_groups = { ...(base.repo_groups || {}), ...local.repo_groups };
  }
  if (Array.isArray(local.rules)) {
    const rules = [...(base.rules || [])];
    for (const r of local.rules) {
      const at = rules.findIndex((x) => x && x.id === r.id);
      if (at >= 0) rules[at] = r; else rules.push(r);
    }
    out.rules = rules;
  }
  return out;
}

export function loadRules(file = rulesPath()) {
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  const localFile = localRulesPath(file);
  const { local, error } = readLocal(localFile);
  const raw = local ? merge(base, local) : base;
  return {
    repoGroups: raw.repo_groups || {},
    docsOnly: raw.docs_only ? new RegExp(raw.docs_only, 'i') : null,
    preToolUseContext: raw.pretooluse_context === 'additionalContext' ? 'additionalContext' : 'deny-once',
    // What the table declared, before the fallback above normalizes it: the self-check validates
    // the declaration, and it has to be the merged one or a typo in the local file passes silently.
    preToolUseContextRaw: raw.pretooluse_context,
    trackSkills: Array.isArray(raw.track_skills) ? raw.track_skills : [],
    allowSkills: Array.isArray(raw.allow_skills) ? raw.allow_skills : [],
    rules: (raw.rules || []).map((r) => ({
      ...r,
      _patterns: (r.patterns || []).map((p) => new RegExp(p, 'iu')),
      _paths: (r.paths || []).map((p) => new RegExp(p, 'i')),
    })),
    // Which sources this table came from, for the console and the self-check.
    localPath: localFile,
    localOverride: Boolean(local),
    localGroups: local && local.repo_groups ? Object.keys(local.repo_groups) : [],
    localError: error,
  };
}

export function repoOf(cwd) {
  const top = repoRoot(cwd);
  return top ? path.basename(top) : null;
}

export function inScope(rule, repo, repoGroups) {
  const scope = rule.repos ?? '*';
  if (scope === '*') return true;
  if (!repo) return false;
  const list = Array.isArray(scope) ? scope : (repoGroups[scope] || []);
  return list.includes(repo);
}

export function rulesFor(loaded, event, repo) {
  return loaded.rules.filter((r) => r.event === event && inScope(r, repo, loaded.repoGroups));
}

// A record wants to know WHICH pattern fired, so the index is the primitive and the boolean is its view.
export function matchPromptIndex(rule, text) {
  const t = String(text || '').slice(0, 4000);
  return rule._patterns.findIndex((re) => re.test(t));
}

export function matchPrompt(rule, text) {
  return matchPromptIndex(rule, text) >= 0;
}

export function matchPath(rule, relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  return rule._paths.some((re) => re.test(p));
}

export function knownSkills(loaded) {
  return [...new Set([...loaded.rules.map((r) => r.skill), ...loaded.trackSkills])];
}

// ~/claude-skills/router/lib/rules.mjs
import fs from 'node:fs';
import path from 'node:path';
import { rulesPath } from './paths.mjs';
import { repoRoot } from './git.mjs';

export function loadRules(file = rulesPath()) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    repoGroups: raw.repo_groups || {},
    docsOnly: raw.docs_only ? new RegExp(raw.docs_only, 'i') : null,
    preToolUseContext: raw.pretooluse_context === 'additionalContext' ? 'additionalContext' : 'deny-once',
    trackSkills: Array.isArray(raw.track_skills) ? raw.track_skills : [],
    allowSkills: Array.isArray(raw.allow_skills) ? raw.allow_skills : [],
    rules: (raw.rules || []).map((r) => ({
      ...r,
      _patterns: (r.patterns || []).map((p) => new RegExp(p, 'iu')),
      _paths: (r.paths || []).map((p) => new RegExp(p, 'i')),
    })),
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

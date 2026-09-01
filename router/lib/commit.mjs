// ~/claude-skills/router/lib/commit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { stagedPaths, trackedModifiedPaths, changedPaths } from './git.mjs';

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;
// What a real command may carry before the verb: `if …; then git commit`, `env FOO=1 git …`.
const PREFIX = String.raw`\s*\(?\s*(?:(?:then|do|else)\s+)?(?:env\s+)?(?:[A-Za-z_]\w*=\S*\s+)*`;
const GOPTS = String.raw`((?:-C\s+\S+\s+|-c\s+\S+\s+|--no-pager\s+|--git-dir=\S+\s+|--work-tree=\S+\s+)*)`;
// git must start the segment (after that prefix); `echo "git commit"` therefore never matches.
const GIT_SUB = new RegExp(`^${PREFIX}git\\s+${GOPTS}(commit|add)\\b(.*)$`, 's');
// SKIP_VERIFY=1 counts only as an env assignment heading a segment, never inside a commit message.
const SKIP = new RegExp(`^${PREFIX}SKIP_VERIFY=1(?:\\s|$)`);
const CD = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/;
const SUBST = /\$\(|`/; // a command substitution's expansion is unknowable from the text
const UNQUOTE = (s) => s.replace(/^['"]|['"]$/g, '');
const ADD_ALL = ['-A', '--all', '.', '-u', '--update', ':/'];
// Options whose VALUE is the next token — otherwise `-m "docs"` reads as the pathspec "docs".
const VALUE_SHORT = new Set(['m', 'F', 't', 'c', 'C']);
const VALUE_LONG = new Set(['--author', '--date', '--message', '--file', '--template', '--reuse-message',
  '--reedit-message', '--fixup', '--squash', '--trailer', '--cleanup', '--pathspec-from-file']);

// Shell-ish word splitting: a quote binds to the word it touches, so `--author="A <a@b>"` is one
// token and `"my file.tsx"` is one path.
function tokens(s) {
  const out = [];
  let cur = '';
  let started = false;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; started = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started) { out.push(cur); cur = ''; started = false; } continue; }
    cur += c; started = true;
  }
  if (started) out.push(cur);
  return out;
}

// Pathspec tokens: options (and the values they consume) dropped, everything after a bare `--` kept.
// A substitution in pathspec position is never dropped — dropping it would empty the candidate set
// and read as "nothing to commit"; it marks the entry unknown so candidateSet fails closed.
function pathspecs(toks) {
  const paths = [];
  let unknown = false;
  const take = (t) => { if (SUBST.test(t)) unknown = true; else paths.push(t); };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--') { for (const r of toks.slice(i + 1)) take(r); break; }
    if (t.startsWith('--')) { if (!t.includes('=') && VALUE_LONG.has(t)) i++; continue; }
    if (t.startsWith('-')) { if (VALUE_SHORT.has(t.slice(-1))) i++; continue; }
    take(t);
  }
  return { paths, unknown };
}

// Quoted text and heredoc bodies are data, not command position: strip them before judging
// SKIP_VERIFY, so a commit message may mention the token without granting the override.
function stripQuotedAndHeredocs(cmd) {
  const lines = String(cmd || '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    const m = lines[i].match(/<<-?\s*['"]?(\w+)['"]?/);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== m[1]) j++;
    i = j; // drop the body and its terminator line
  }
  return kept.join('\n').replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
}

export function parseCommand(command) {
  const cmd = String(command || '');
  const segs = cmd.split(SEGMENT_SPLIT);
  const skip = stripQuotedAndHeredocs(cmd).split(SEGMENT_SPLIT).some((s) => SKIP.test(s));
  const adds = [];
  let commit = null;
  let cd = null;
  for (const seg of segs) {
    const cdm = seg.match(CD);
    if (cdm) { cd = cdm[1] ?? cdm[2] ?? cdm[3]; continue; }
    const m = seg.match(GIT_SUB);
    if (!m) continue;
    const gopts = m[1] || '';
    const sub = m[2];
    const rest = m[3] || '';
    const cm = gopts.match(/-C\s+(\S+)/);
    const cPath = cm ? UNQUOTE(cm[1]) : null;
    const toks = tokens(rest);
    const base = cPath || cd || null;
    const spec = pathspecs(toks);
    if (sub === 'add') {
      const all = toks.some((t) => ADD_ALL.includes(t));
      adds.push({ all, paths: spec.paths.filter((t) => t !== '.'), cPath, base, unknown: spec.unknown });
    } else {
      const all = /(?:^|\s)(?:--all|-[a-zA-Z]*a[a-zA-Z]*)(?=\s|$)/.test(rest);
      const amend = /--amend\b/.test(rest);
      commit = { all, amend, cPath, base, paths: spec.paths, unknown: spec.unknown };
    }
  }
  return { isCommit: commit !== null, commit, adds, skip };
}

export function bashWriteTargets(command) {
  const cmd = String(command || '');
  const out = [];
  for (const m of cmd.matchAll(/(?:^|[^<>&\d])>{1,2}\|?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|'"<>]+))/g)) out.push(m[1] ?? m[2] ?? m[3]);
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?(['"]?)([^\s;&|'"]+)\1/g)) out.push(m[2]);
  return out.filter((t) => t !== '/dev/null');
}

// git pathspec globs: `*` crosses `/` (wildmatch without WM_PATHNAME), so `web/*.ts*` reaches
// web/app/page.tsx exactly as `git add` would. Anchored; a malformed pattern yields null.
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') i++; re += '.*'; }
    else if (c === '?') re += '.';
    else if (c === '[') { const j = g.indexOf(']', i + 1); if (j === -1) return null; re += g.slice(i, j + 1); i = j; }
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`); } catch { return null; }
}

// Repo-relative paths the command would commit, resolving each pathspec against its own base
// (`git -C x` / a preceding `cd x`) and then the hook's cwd. Returns null when a listing failed:
// "could not tell" must never reach the gate as "nothing to commit".
export function candidateSet(top, commit, adds, cwd = top) {
  if ((commit && commit.unknown) || (adds || []).some((a) => a && a.unknown)) return null;
  const staged = stagedPaths(top);
  if (staged == null) return null;
  const set = new Set(staged);
  let changed;
  const listChanged = () => (changed === undefined ? (changed = changedPaths(top)) : changed);
  if (commit && commit.all) {
    const mod = trackedModifiedPaths(top);
    if (mod == null) return null;
    for (const p of mod) set.add(p);
  }
  const entries = commit ? [{ all: false, base: commit.base, paths: commit.paths }, ...(adds || [])] : [...(adds || [])];
  for (const e of entries) {
    if (e.all) {
      const c = listChanged();
      if (c == null) return null;
      for (const p of c) set.add(p);
      continue;
    }
    for (const raw of e.paths || []) {
      // An unexpanded `~`/`$VAR` base resolves literally: the phantom path over-includes, which
      // is the safe direction — the gate then checks more, never less.
      const abs = path.resolve(cwd || top, e.base || '.', raw);
      const rel = path.relative(top, abs).replace(/\\/g, '/');
      if (rel === '..' || rel.startsWith('../')) continue; // outside the repo
      const glob = /[*?[]/.test(raw);
      let isDir = false;
      if (!glob) { try { isDir = fs.statSync(abs).isDirectory(); } catch {} }
      if (!glob && !isDir && rel !== '') { set.add(rel); continue; }
      const c = listChanged();
      if (c == null) return null;
      if (rel === '') { for (const p of c) set.add(p); continue; } // the repo root itself
      if (isDir) { for (const p of c) if (p === rel || p.startsWith(rel + '/')) set.add(p); continue; }
      const re = globRe(rel);
      const hits = re ? c.filter((p) => re.test(p)) : [];
      for (const p of hits.length ? hits : c) set.add(p); // no hit → conservative: everything changed
    }
  }
  return [...set];
}

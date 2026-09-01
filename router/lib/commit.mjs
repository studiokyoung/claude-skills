// ~/claude-skills/router/lib/commit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { stagedPaths, trackedModifiedPaths, changedPaths } from './git.mjs';

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\||\n)\s*/;
// git must start the segment (after optional VAR=val prefixes); "echo \"git commit\"" therefore never matches.
const GIT_SUB = /^\s*\(?\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*git\s+((?:-C\s+\S+\s+|-c\s+\S+\s+|--no-pager\s+|--git-dir=\S+\s+|--work-tree=\S+\s+)*)(commit|add)\b(.*)$/s;
const UNQUOTE = (s) => s.replace(/^['"]|['"]$/g, '');

export function parseCommand(command) {
  const cmd = String(command || '');
  const skip = /(?:^|[\s;&|(])SKIP_VERIFY=1(?:\s|$)/.test(cmd);
  const adds = [];
  let commit = null;
  for (const seg of cmd.split(SEGMENT_SPLIT)) {
    const m = seg.match(GIT_SUB);
    if (!m) continue;
    const gopts = m[1] || '';
    const sub = m[2];
    const rest = m[3] || '';
    const cm = gopts.match(/-C\s+(\S+)/);
    const cPath = cm ? UNQUOTE(cm[1]) : null;
    if (sub === 'add') {
      const toks = rest.trim().split(/\s+/).filter(Boolean);
      const all = toks.some((t) => ['-A', '--all', '.', '-u', '--update', ':/'].includes(t));
      adds.push({ all, paths: toks.filter((t) => !t.startsWith('-') && t !== '.').map(UNQUOTE), cPath });
    } else {
      const all = /(?:^|\s)(?:--all|-[a-zA-Z]*a[a-zA-Z]*)(?=\s|$)/.test(rest);
      const amend = /--amend\b/.test(rest);
      commit = { all, amend, cPath };
    }
  }
  return { isCommit: commit !== null, commit, adds, skip };
}

export function bashWriteTargets(command) {
  const cmd = String(command || '');
  const out = [];
  for (const m of cmd.matchAll(/(?:^|[^<>&\d])>{1,2}\s*(['"]?)([^\s;&|'"<>]+)\1/g)) out.push(m[2]);
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?(['"]?)([^\s;&|'"]+)\1/g)) out.push(m[2]);
  return out.filter((t) => t !== '/dev/null');
}

export function candidateSet(top, commit, adds) {
  const set = new Set(stagedPaths(top));
  if (commit && commit.all) for (const p of trackedModifiedPaths(top)) set.add(p);
  for (const a of adds || []) {
    if (a.all) { for (const p of changedPaths(top)) set.add(p); continue; }
    for (const raw of a.paths || []) {
      const abs = path.resolve(top, raw);
      const rel = path.relative(top, abs).replace(/\\/g, '/');
      let isDir = false;
      try { isDir = fs.statSync(abs).isDirectory(); } catch {}
      if (isDir) for (const c of changedPaths(top)) { if (c === rel || c.startsWith(rel + '/')) set.add(c); }
      else set.add(rel);
    }
  }
  return [...set];
}

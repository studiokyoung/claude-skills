// ~/claude-skills/router/lib/git.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function git(args, cwd, opts = {}) {
  try {
    if (!cwd || !fs.existsSync(cwd)) return null;
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 4000,
      input: opts.input,
    });
  } catch {
    return null;
  }
}

export function toplevel(cwd) {
  const out = git(['rev-parse', '--show-toplevel'], cwd);
  return out ? out.trim() : null;
}

export function gitDir(cwd) {
  const out = git(['rev-parse', '--git-dir'], cwd);
  if (!out) return null;
  const d = out.trim();
  return path.isAbsolute(d) ? d : path.join(toplevel(cwd) || cwd, d);
}

export function head(cwd) {
  const out = git(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
  return out ? out.trim() : 'EMPTY';
}

// porcelain v1 with -z: "XY path\0" and, for renames/copies, the original path as the next token.
export function statusEntries(cwd) {
  const raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  if (raw == null) return null;
  const parts = raw.split('\0').filter((p) => p.length > 0);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    entries.push({ xy, path: parts[i].slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return entries;
}

export function changedPaths(cwd) {
  const e = statusEntries(cwd);
  return e ? e.map((x) => x.path) : [];
}

export function stagedPaths(cwd) {
  const out = git(['diff', '--cached', '--name-only', '-z'], cwd);
  return out ? out.split('\0').filter(Boolean) : [];
}

export function trackedModifiedPaths(cwd) {
  const out = git(['diff', '--name-only', '-z'], cwd);
  return out ? out.split('\0').filter(Boolean) : [];
}

export function fingerprint(cwd) {
  const top = toplevel(cwd);
  if (!top) return null;
  const entries = statusEntries(top);
  if (entries == null) return null;
  const existing = entries.map((e) => e.path).filter((p) => {
    try { return fs.statSync(path.join(top, p)).isFile(); } catch { return false; }
  });
  const hashes = existing.length ? (git(['hash-object', '--stdin-paths'], top, { input: existing.join('\n') + '\n' }) || '') : '';
  const h = crypto.createHash('sha256');
  h.update(head(top)); h.update('\n');
  h.update(entries.map((e) => `${e.xy} ${e.path}`).join('\n')); h.update('\n');
  h.update(hashes);
  return h.digest('hex');
}

export function markerPath(cwd) {
  const d = gitDir(cwd);
  return d ? path.join(d, 'verify-pass') : null;
}

export function readMarker(cwd) {
  try { return JSON.parse(fs.readFileSync(markerPath(cwd), 'utf8')); } catch { return null; }
}

export function writeMarker(cwd, data) {
  const p = markerPath(cwd);
  if (!p) return false;
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return true;
}

export function clearMarker(cwd) {
  try { const p = markerPath(cwd); if (p) fs.unlinkSync(p); } catch {}
}

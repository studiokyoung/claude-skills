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

// 'EMPTY' only for a real unborn HEAD; null when git itself failed (no repo, timeout) so callers
// cannot mistake a broken git for a fresh repo.
export function head(cwd) {
  const out = git(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
  if (out) return out.trim();
  return git(['rev-parse', '--git-dir'], cwd) == null ? null : 'EMPTY';
}

// porcelain v1 with -z: "XY path\0" and, for renames/copies, the original path as the next token.
export function statusEntries(cwd) {
  const raw = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  if (raw == null) return null;
  const parts = raw.split('\0').filter((p) => p.length > 0);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    const p = parts[i].slice(3);
    const orig = xy[0] === 'R' || xy[0] === 'C' ? parts[++i] ?? null : null;
    entries.push({ xy, path: p, orig });
  }
  return entries;
}

// These three return null (never []) when git failed: "could not list" must never read as "nothing".
export function changedPaths(cwd) {
  const e = statusEntries(cwd);
  return e ? e.map((x) => x.path) : null;
}

export function stagedPaths(cwd) {
  const out = git(['diff', '--cached', '--name-only', '-z'], cwd);
  return out == null ? null : out.split('\0').filter(Boolean);
}

export function trackedModifiedPaths(cwd) {
  const out = git(['diff', '--name-only', '-z'], cwd);
  return out == null ? null : out.split('\0').filter(Boolean);
}

// Content of the working tree, independent of staging: XY collapses to a change class (D/C) and the
// lines are sorted, so `git add` between /verify and `git commit` is not a tree change; file modes
// join the blob hashes so a chmod on an already-dirty file still moves it. Fails closed — any git
// failure returns null rather than a hash computed over less than the whole tree.
export function fingerprint(cwd) {
  const top = toplevel(cwd);
  if (!top) return null;
  const entries = statusEntries(top);
  if (entries == null) return null;
  const h0 = head(top);
  if (h0 == null) return null;
  const lines = [];
  const existing = [];
  const modes = [];
  for (const e of entries) {
    lines.push(`${e.xy.includes('D') ? 'D' : 'C'} ${e.path}`);
    if (e.orig) lines.push(`D ${e.orig}`);
    let st = null;
    try { st = fs.statSync(path.join(top, e.path)); } catch {}
    if (!st || !st.isFile()) continue;
    existing.push(e.path);
    modes.push(`${(st.mode & 0o777).toString(8)} ${e.path}`);
  }
  lines.sort();
  modes.sort();
  let hashes = '';
  if (existing.length) {
    const raw = git(['hash-object', '--stdin-paths'], top, { input: existing.join('\n') + '\n' });
    if (raw == null) return null;
    hashes = raw;
  }
  const h = crypto.createHash('sha256');
  h.update(h0); h.update('\n');
  h.update(lines.join('\n')); h.update('\n');
  h.update(modes.join('\n')); h.update('\n');
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
  try { fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n'); } catch { return false; }
  return true;
}

export function clearMarker(cwd) {
  try { const p = markerPath(cwd); if (p) fs.unlinkSync(p); } catch {}
}

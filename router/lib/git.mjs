// ~/claude-skills/router/lib/git.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

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

// ~/claude-skills/router/lib/gate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { rulesFor, matchPath } from './rules.mjs';
import { toplevel, fingerprint, readMarker } from './git.mjs';
import { candidateSet } from './commit.mjs';
import { hasRun } from './ledger.mjs';

// toplevel() returns a physical path; resolve the hook's cwd the same way so path.relative agrees.
const realCwd = (c) => {
  const base = c || process.cwd();
  try { return fs.realpathSync(base); } catch { return base; }
};

export function decideCommit(loaded, input, parsed) {
  const c = parsed.commit;
  const cwd = realCwd(input.cwd);
  const base = c.cPath ? path.resolve(cwd, c.cPath) : cwd;
  const top = toplevel(base);
  const repo = top ? path.basename(top) : null;
  const rule = rulesFor(loaded, 'pre-commit', repo).find((r) => r.mode === 'block');
  if (!rule) return { decision: 'allow', why: 'out-of-scope', ruleId: '-', repo };
  if (parsed.skip) return { decision: 'allow', why: 'override SKIP_VERIFY', ruleId: rule.id, repo };
  const cand = candidateSet(top, c, parsed.adds);
  if (cand.length === 0) return { decision: 'allow', why: 'nothing-to-commit', ruleId: rule.id, repo };
  if (loaded.docsOnly && cand.every((p) => loaded.docsOnly.test(p))) return { decision: 'allow', why: 'docs-only', ruleId: rule.id, repo };
  const marker = readMarker(top);
  const fp = fingerprint(top);
  if (marker && fp && marker.fingerprint === fp) return { decision: 'allow', why: `verified ${marker.ts}`, ruleId: rule.id, repo };
  const why = marker ? `tree changed since ${marker.ts}` : 'marker missing';
  return { decision: 'deny', why, ruleId: rule.id, repo, message: String(rule.message || '').replace('{why}', why) };
}

export function decideBackstop(loaded, ledger, input, targets) {
  if (!targets || targets.length === 0) return null;
  const cwd = realCwd(input.cwd);
  const top = toplevel(cwd);
  const repo = top ? path.basename(top) : null;
  for (const rule of rulesFor(loaded, 'new-file', repo)) {
    if (rule.mode !== 'remind') continue;
    if (rule.once_per_session && ledger.reminded[rule.id]) continue;
    if (rule.unless_ran && hasRun(ledger, rule.unless_ran)) continue;
    for (const t of targets) {
      const abs = path.resolve(cwd, t);
      if (fs.existsSync(abs)) continue;
      const rel = path.relative(top || cwd, abs).replace(/\\/g, '/');
      if (matchPath(rule, rel)) return { rule, hit: abs, rel, repo };
    }
  }
  return null;
}

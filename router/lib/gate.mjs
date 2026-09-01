// ~/claude-skills/router/lib/gate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { rulesFor, matchPath, repoOf } from './rules.mjs';
import { toplevel, fingerprint, readMarker } from './git.mjs';
import { candidateSet } from './commit.mjs';
import { hasRun } from './ledger.mjs';
import { home } from './paths.mjs';

// toplevel() returns a physical path; resolve the hook's cwd the same way so path.relative agrees.
const realCwd = (c) => {
  const base = c || process.cwd();
  try { return fs.realpathSync(base); } catch { return base; }
};

// `~/x` and `$OUT/x` are unexpanded shell text, not literal paths: never burn the once-per-session
// reminder on a file that will never exist under that name.
const PHANTOM = /^~|\$/;

// A shell would have expanded `cd ~/x` before git ever ran, but the hook sees the literal text.
// Only a leading ~ is recoverable here; a $VAR base stays unresolvable and relies on the fallback below.
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(home(), p.slice(1)) : p);

// A rule may carry no message; a deny must still say why.
const denyMessage = (rule, why) => (rule.message ? String(rule.message).replace('{why}', why) : `verify gate: ${why}`);

export function decideCommit(loaded, input, parsed) {
  const c = parsed.commit;
  const cwd = realCwd(input.cwd);
  // The repo is the one the command itself targets (`git -C x`, or a preceding `cd x`) — not the
  // hook's cwd, which `cd repo && git commit` would otherwise let the gate read from the wrong repo.
  // The expanded bases must flow down too: candidateSet re-resolves each pathspec against its own
  // base, and a raw `~/repo` there sends every path outside the repo — an empty, silently allowed set.
  let eb = expandHome(c.base || c.cPath || '.');
  let top = toplevel(path.resolve(cwd, eb));
  let adds = (parsed.adds || []).map((a) => ({ ...a, base: expandHome(a.base || '.') }));
  // …but a base we cannot resolve (an unexpanded $VAR, a `cd` to a non-repo, or `cd web && cd ..`
  // since cd does not compose) must fall back to the hook's own repo. Reading it as "no repo" would
  // silently allow the commit. git then runs in the hook's cwd, so the pathspecs resolve there too:
  // keeping the outside base would push every path clear of `top` and empty the set into a silent allow.
  if (!top) { top = toplevel(cwd); eb = '.'; adds = adds.map((a) => ({ ...a, base: '.' })); }
  // Identity comes from the main checkout (worktrees), while `top` stays the working tree the
  // pathspecs, the marker and the fingerprint all belong to.
  const repo = repoOf(top);
  const rule = rulesFor(loaded, 'pre-commit', repo).find((r) => r.mode === 'block');
  if (!rule) return { decision: 'allow', why: 'out-of-scope', ruleId: '-', repo };
  if (parsed.skip) return { decision: 'allow', why: 'override SKIP_VERIFY', ruleId: rule.id, repo };
  // null = a git listing failed. "Could not tell" is not "nothing to commit": skip both shortcuts
  // and let the marker decide.
  const cand = candidateSet(top, { ...c, base: eb }, adds, cwd);
  if (cand) {
    if (cand.length === 0) return { decision: 'allow', why: 'nothing-to-commit', ruleId: rule.id, repo };
    if (loaded.docsOnly && cand.every((p) => loaded.docsOnly.test(p))) return { decision: 'allow', why: 'docs-only', ruleId: rule.id, repo };
  }
  const marker = readMarker(top);
  const fp = fingerprint(top);
  if (marker && fp && marker.fingerprint === fp) return { decision: 'allow', why: `verified ${marker.ts}`, ruleId: rule.id, repo };
  const why = !fp ? 'fingerprint unavailable (git failed)' : marker ? `tree changed since ${marker.ts}` : 'marker missing';
  return { decision: 'deny', why, ruleId: rule.id, repo, message: denyMessage(rule, why) };
}

export function decideBackstop(loaded, ledger, input, targets) {
  if (!targets || targets.length === 0) return null;
  const cwd = realCwd(input.cwd);
  const top = toplevel(cwd);
  const repo = repoOf(top);
  for (const rule of rulesFor(loaded, 'new-file', repo)) {
    if (rule.mode !== 'remind') continue;
    if (!rule.message) continue;
    if (rule.once_per_session && ledger.reminded[rule.id]) continue;
    if (rule.unless_ran && hasRun(ledger, rule.unless_ran)) continue;
    for (const t of targets) {
      if (PHANTOM.test(t)) continue;
      const abs = path.resolve(cwd, t);
      if (fs.existsSync(abs)) continue;
      const rel = path.relative(top || cwd, abs).replace(/\\/g, '/');
      if (matchPath(rule, rel)) return { rule, hit: abs, rel, repo };
    }
  }
  return null;
}

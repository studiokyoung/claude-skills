// ~/claude-skills/router/test/pre-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHook, testEnv, makeRepo, hookInput, tmpDir } from './helpers.mjs';
import { loadRules, repoOf } from '../lib/rules.mjs';

const mode = loadRules().preToolUseContext;
const bash = (cwd, command, over = {}) => hookInput({ cwd, tool_name: 'Bash', tool_input: { command }, ...over });
const write = (cwd, file_path, over = {}) => hookInput({ cwd, tool_name: 'Write', tool_input: { file_path, content: 'x' }, ...over });
const dirty = (name, rel = 'web/app/page.tsx') => {
  const r = makeRepo(name, { [rel]: 'a', 'README.md': 'r' });
  fs.writeFileSync(path.join(r.dir, rel), 'a2');
  r.git('add', rel);
  return r;
};
const logOf = (root) => fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8');
const recsOf = (root, skill) => { try { return fs.readFileSync(path.join(root, 'runs', `${skill}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

test('deny: web repo, staged code, no marker', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  const r = runHook('pre-tool.mjs', bash(dir, 'git commit -m "feat"'), env);
  assert.equal(r.status, 0);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /marker missing/);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /SKIP_VERIFY=1/);
  assert.match(logOf(root), /\tcommit\tverify-commit-gate\tportfolio-html\tdeny\tmarker missing/);
});

test('allow after mark-pass; deny again once the tree changes', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  runHook('mark-pass.mjs', null, env, ['--root', dir]);
  const ok = runHook('pre-tool.mjs', bash(dir, 'git commit -m "feat"'), env);
  assert.equal(ok.stdout.trim(), '');
  assert.match(logOf(root), /\tallow\tverified /);
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'a3');
  const stale = runHook('pre-tool.mjs', bash(dir, 'git commit -am "feat"'), env);
  assert.match(stale.json.hookSpecificOutput.permissionDecisionReason, /tree changed since/);
});

test('docs-only, SKIP_VERIFY, nothing-to-commit, out-of-scope all pass silently', () => {
  const { root, env } = testEnv();
  const docs = makeRepo('portfolio-html', { 'README.md': 'r', 'web/app/page.tsx': 'a' });
  fs.writeFileSync(path.join(docs.dir, 'README.md'), 'r2'); docs.git('add', 'README.md');
  assert.equal(runHook('pre-tool.mjs', bash(docs.dir, 'git commit -m "docs"'), env).stdout.trim(), '');
  assert.match(logOf(root), /\tallow\tdocs-only/);
  const code = dirty('portfolio-html');
  assert.equal(runHook('pre-tool.mjs', bash(code.dir, 'SKIP_VERIFY=1 git commit -m "hotfix: reason"'), env).stdout.trim(), '');
  assert.match(logOf(root), /\tallow\toverride SKIP_VERIFY/);
  const clean = makeRepo('portfolio-html');
  assert.equal(runHook('pre-tool.mjs', bash(clean.dir, 'git commit -m "nothing"'), env).stdout.trim(), '');
  assert.match(logOf(root), /\tallow\tnothing-to-commit/);
  const other = dirty('Self-GraphDB', 'agents/keeper.sh');
  assert.equal(runHook('pre-tool.mjs', bash(other.dir, 'git commit -m "x"'), env).stdout.trim(), '');
  assert.match(logOf(root), /\tcommit\t-\tSelf-GraphDB\tallow\tout-of-scope/);
});

test('git -C <repo> from elsewhere and "git add -A && git commit" with untracked code are gated', () => {
  const { env } = testEnv();
  const { dir } = dirty('portfolio-html');
  const elsewhere = runHook('pre-tool.mjs', bash('/tmp', `git -C ${dir} commit -m "x"`), env);
  assert.equal(elsewhere.json.hookSpecificOutput.permissionDecision, 'deny');
  const fresh = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  fs.mkdirSync(path.join(fresh.dir, 'web/lib'), { recursive: true });
  fs.writeFileSync(path.join(fresh.dir, 'web/lib/new.ts'), 'n');
  const addAll = runHook('pre-tool.mjs', bash(fresh.dir, 'git add -A && git commit -m "x"'), env);
  assert.equal(addAll.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('new-file backstop: fires once per session for Write and for a Bash heredoc, honors unless_ran and existing files', () => {
  const { root, env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/components/Existing.tsx': 'x', 'web/app/page.tsx': 'a' });
  const first = runHook('pre-tool.mjs', write(dir, path.join(dir, 'web/components/Toast.tsx'), { session_id: 's-w' }), env);
  assert.equal(first.status, 0);
  const out = first.json.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  if (mode === 'additionalContext') {
    assert.match(out.additionalContext, /^\[skill-router\] .*reuse-scout/);
    assert.equal(out.permissionDecision, undefined);
  } else {
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /^\[skill-router\] .*reuse-scout/);
    assert.match(out.permissionDecisionReason, /retry the same call/);
  }
  assert.match(logOf(root), /\tnew-file\treuse-scout-new-file\tportfolio-html\t(remind|deny-once)\t/);
  const again = runHook('pre-tool.mjs', write(dir, path.join(dir, 'web/components/Toast.tsx'), { session_id: 's-w' }), env);
  assert.equal(again.stdout.trim(), '');
  const heredoc = runHook('pre-tool.mjs', bash(dir, "cat > web/hooks/useToast.ts <<'EOF'\nexport {}\nEOF", { session_id: 's-h' }), env);
  assert.ok(heredoc.json, 'heredoc to a new hooks/ file should fire');
  const existing = runHook('pre-tool.mjs', write(dir, path.join(dir, 'web/components/Existing.tsx'), { session_id: 's-x' }), env);
  assert.equal(existing.stdout.trim(), '');
  const docs = runHook('pre-tool.mjs', write(dir, path.join(dir, 'docs/notes.md'), { session_id: 's-y' }), env);
  assert.equal(docs.stdout.trim(), '');
  runHook('on-prompt.mjs', hookInput({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's-z', prompt: '/reuse-scout toast' }), env);
  const afterScout = runHook('pre-tool.mjs', write(dir, path.join(dir, 'web/components/Toast2.tsx'), { session_id: 's-z' }), env);
  assert.equal(afterScout.stdout.trim(), '');
});

test('malformed stdin, Edit tool, and non-commit Bash without redirects: exit 0, no output', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html');
  const r = runHook('pre-tool.mjs', null, env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(runHook('pre-tool.mjs', hookInput({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'web/components/New.tsx') } }), env).stdout.trim(), '');
  assert.equal(runHook('pre-tool.mjs', bash(dir, 'ls -la && git status'), env).stdout.trim(), '');
});

test('cd <repo> && git commit is gated by the target repo, not the hook cwd', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  const other = makeRepo('Self-GraphDB');
  const r = runHook('pre-tool.mjs', bash(other.dir, `cd ${dir} && git commit -m "x"`), env);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  const back = runHook('pre-tool.mjs', bash(dir, `cd ${other.dir} && git commit -m "x"`), env);
  assert.equal(back.stdout.trim(), '');
  assert.match(logOf(root), /\tcommit\t-\tSelf-GraphDB\tallow\tout-of-scope/);
});

test('an unstaged pathspec commit is gated; from a subdirectory too', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'a2');
  const r = runHook('pre-tool.mjs', bash(dir, 'git commit -m "x" web/app/page.tsx'), env);
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  const sub = runHook('pre-tool.mjs', bash(path.join(dir, 'web'), 'git add app/page.tsx && git commit -m "x"'), env);
  assert.equal(sub.json.hookSpecificOutput.permissionDecision, 'deny');
  // Resolved against the real cwd, not the repo root: `../` out of a subdirectory otherwise escapes
  // the repo, empties the candidate set and reads as nothing-to-commit.
  const up = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a', 'src/new.ts': 'n' });
  fs.writeFileSync(path.join(up.dir, 'src/new.ts'), 'n2');
  const upward = runHook('pre-tool.mjs', bash(path.join(up.dir, 'web'), 'git add ../src/new.ts && git commit -m "x"'), env);
  assert.equal(upward.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('git failure fails closed with an honest reason', () => {
  const { env } = testEnv();
  const repo = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a', 'web/app/bad.txt': 'x' });
  const dir = repo.dir;
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'a2');
  repo.git('add', 'web/app/page.tsx');
  // Tracked, so the fingerprint hashes its content and the unreadable file fails the whole hash.
  const bad = path.join(dir, 'web/app/bad.txt');
  fs.writeFileSync(bad, 'xx'); fs.chmodSync(bad, 0o000);
  try {
    const r = runHook('pre-tool.mjs', bash(dir, 'git commit -am "x"'), env);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /fingerprint unavailable/);
  } finally { fs.chmodSync(bad, 0o644); }
  // An unreadable index fails the listing itself: "could not tell" must not read as nothing-to-commit.
  const idx = path.join(dir, '.git/index');
  fs.chmodSync(idx, 0o000);
  try {
    const r = runHook('pre-tool.mjs', bash(dir, 'git commit -m "x"'), env);
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /fingerprint unavailable/);
  } finally { fs.chmodSync(idx, 0o644); }
});

test('a broken rules file logs and allows; phantom redirect targets are ignored; message-less rules never emit', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  const broken = runHook('pre-tool.mjs', bash(dir, 'git commit -m "x"'), { ...env, ROUTER_RULES: path.join(root, 'missing.json') });
  assert.equal(broken.status, 0); assert.equal(broken.stdout.trim(), '');
  assert.match(logOf(root), /rules-load-failed/);
  const home = runHook('pre-tool.mjs', bash(dir, "cat > ~/proj/lib/x.ts <<'EOF'\nx\nEOF", { session_id: 's-t' }), env);
  assert.equal(home.stdout.trim(), '');
  const dollar = runHook('pre-tool.mjs', bash(dir, "cat > $OUT/lib/x.ts <<'EOF'\nx\nEOF", { session_id: 's-u' }), env);
  assert.equal(dollar.stdout.trim(), '');
  const rules = JSON.parse(fs.readFileSync(env.ROUTER_RULES, 'utf8'));
  rules.rules.find((x) => x.id === 'reuse-scout-new-file').message = '';
  rules.rules.find((x) => x.id === 'verify-commit-gate').message = '';
  const file = path.join(root, 'rules.json'); fs.writeFileSync(file, JSON.stringify(rules));
  const quiet = runHook('pre-tool.mjs', write(dir, path.join(dir, 'web/components/Quiet.tsx'), { session_id: 's-q' }), { ...env, ROUTER_RULES: file });
  assert.equal(quiet.stdout.trim(), '');
  // A blocking rule with no message must still deny with a readable reason, never an empty string.
  const blank = runHook('pre-tool.mjs', bash(dir, 'git commit -m "x"'), { ...env, ROUTER_RULES: file });
  assert.equal(blank.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(blank.json.hookSpecificOutput.permissionDecisionReason, 'verify gate: marker missing');
});

test('an unresolvable or tilde cd base falls back to the hook repo (never out-of-scope)', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  for (const cmd of ['cd $HOME/portfolio-html && git commit -m "x"', 'cd web && cd .. && git commit -m "x"', 'cd web && npm test && cd - && git commit -m "x"']) {
    const r = runHook('pre-tool.mjs', bash(dir, cmd), env);
    assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny', cmd);
  }
  const homeEnv = { ...env, HOME: path.dirname(dir) };
  const other = makeRepo('Self-GraphDB');
  const tilde = runHook('pre-tool.mjs', bash(other.dir, 'cd ~/portfolio-html && git commit -m "x"'), homeEnv);
  assert.equal(tilde.json && tilde.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(logOf(root), /\tcommit\tverify-commit-gate\tportfolio-html\tdeny\t/);
});

test('tilde cd from another repo gates an unstaged pathspec commit too', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'a2');
  const other = makeRepo('Self-GraphDB');
  const homeEnv = { ...env, HOME: path.dirname(dir) };
  const r = runHook('pre-tool.mjs', bash(other.dir, 'cd ~/portfolio-html && git commit web/app/page.tsx -m "x"'), homeEnv);
  assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny');
  const ctrl = runHook('pre-tool.mjs', bash(other.dir, `cd ${dir} && git commit web/app/page.tsx -m "x"`), env);
  assert.equal(ctrl.json && ctrl.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('a cd to a non-repo (or failing cd) still gates pathspec commits in the hook repo', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'a2');
  for (const cmd of ['cd ~/nowhere; git commit web/app/page.tsx -m "x"', 'cd $NOWHERE; git commit web/app/page.tsx -m "x"', 'cd ~/nowhere && git add web/app/page.tsx && git commit -m "x"']) {
    const r = runHook('pre-tool.mjs', bash(dir, cmd), env);
    assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny', cmd);
  }
});

test('a worktree is identified by its main repo, so a commit inside it is gated', () => {
  const { env } = testEnv();
  const { dir, git } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  const wt = path.join(path.dirname(dir), 'wt-feature');
  git('worktree', 'add', '-q', wt);
  assert.equal(repoOf(wt), 'portfolio-html');
  fs.writeFileSync(path.join(wt, 'web/app/page.tsx'), 'a2');
  const r = runHook('pre-tool.mjs', bash(wt, 'git commit web/app/page.tsx -m "x"'), env);
  assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('a subshell and a -C composed with cd are gated by the repo they target', () => {
  const { env } = testEnv();
  const { dir } = dirty('portfolio-html');
  const other = makeRepo('Self-GraphDB');
  const sub = runHook('pre-tool.mjs', bash(other.dir, `(cd ${dir} && git commit -am "x")`), env);
  assert.equal(sub.json && sub.json.hookSpecificOutput.permissionDecision, 'deny');
  const here = runHook('pre-tool.mjs', bash(other.dir, `cd ${dir} && git -C . commit web/app/page.tsx -m "x"`), env);
  assert.equal(here.json && here.json.hookSpecificOutput.permissionDecision, 'deny');
  const up = runHook('pre-tool.mjs', bash(other.dir, `cd ${dir}/web && git -C .. commit web/app/page.tsx -m "x"`), env);
  assert.equal(up.json && up.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('a repo reached through a symlinked parent is still gated', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'a2');
  const link = path.join(tmpDir('link-'), 'projects');
  fs.symlinkSync(path.dirname(dir), link);
  const other = makeRepo('Self-GraphDB');
  const r = runHook('pre-tool.mjs', bash(other.dir, `cd ${link}/portfolio-html && git commit web/app/page.tsx -m "x"`), env);
  assert.equal(r.json && r.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('a redirect after a cd is resolved under that cd, not the hook cwd', () => {
  const { env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  const scratch = makeRepo('scratchpad', { 'web/components/Toast.tsx': 'x' });
  // The file already exists where it is actually written, so nothing is being created: the
  // session's one reminder must not be burned on <hookcwd>/web/components/Toast.tsx.
  const quiet = runHook('pre-tool.mjs', bash(dir, `cd ${scratch.dir} && cat > web/components/Toast.tsx <<'EOF'\nx\nEOF`, { session_id: 's-cd' }), env);
  assert.equal(quiet.stdout.trim(), '');
  const fires = runHook('pre-tool.mjs', bash(dir, `cd ${scratch.dir} && cat > web/components/New.tsx <<'EOF'\nx\nEOF`, { session_id: 's-cd2' }), env);
  assert.ok(fires.json, 'a genuinely new file under the cd base still reminds');
});

test('the new-file backstop writes one remind record per session, with the target it fired on', () => {
  const { root, env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'a' });
  const first = runHook('pre-tool.mjs', write(dir, path.join(dir, 'web/components/Toast.tsx'), { session_id: 's-nr', prompt_id: 'p2' }), env);
  assert.ok(first.json);
  const recs = recsOf(root, 'reuse-scout');
  assert.equal(recs.length, 1);
  const [rec] = recs;
  assert.equal(rec.type, 'remind'); assert.equal(rec.skill, 'reuse-scout');
  assert.equal(rec.rule, 'reuse-scout-new-file'); assert.equal(rec.delivery, 'new-file');
  assert.equal(rec.target, 'web/components/Toast.tsx');
  assert.equal(rec.repo, 'portfolio-html');
  assert.equal(rec.session_id, 's-nr'); assert.equal(rec.prompt_id, 'p2');
  assert.equal(rec.pattern_index, null);
  assert.equal(rec.prompt_excerpt, undefined);
  const again = runHook('pre-tool.mjs', write(dir, path.join(dir, 'web/components/Toast.tsx'), { session_id: 's-nr', prompt_id: 'p3' }), env);
  assert.equal(again.stdout.trim(), '');
  assert.equal(recsOf(root, 'reuse-scout').length, 1);
});

test('every in-scope commit decision writes a gate record; an out-of-scope one writes none', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  const denied = runHook('pre-tool.mjs', bash(dir, 'git commit  -m   "feat"', { session_id: 's-g', prompt_id: 'pg' }), env);
  assert.equal(denied.json.hookSpecificOutput.permissionDecision, 'deny');
  const [no] = recsOf(root, 'verify');
  assert.equal(no.type, 'gate'); assert.equal(no.skill, 'verify');
  assert.equal(no.decision, 'deny'); assert.equal(no.why, 'marker missing');
  assert.equal(no.candidates, 1); assert.equal(no.docs_only, false);
  assert.equal(no.marker_ts, null); assert.equal(no.marker_age_s, null);
  assert.equal(no.repo, 'portfolio-html'); assert.equal(no.session_id, 's-g'); assert.equal(no.prompt_id, 'pg');
  assert.equal(no.command_excerpt, 'git commit -m "feat"');
  runHook('mark-pass.mjs', null, env, ['--root', dir]);
  assert.equal(runHook('pre-tool.mjs', bash(dir, 'git commit -m "feat"'), env).stdout.trim(), '');
  const yes = recsOf(root, 'verify')[1];
  assert.equal(yes.decision, 'allow');
  assert.match(yes.why, /^verified /);
  assert.ok(yes.marker_ts);
  assert.equal(typeof yes.marker_age_s, 'number');
  assert.ok(yes.marker_age_s >= 0);
  const docs = makeRepo('portfolio-html', { 'README.md': 'r', 'web/app/page.tsx': 'a' });
  fs.writeFileSync(path.join(docs.dir, 'README.md'), 'r2'); docs.git('add', 'README.md');
  runHook('pre-tool.mjs', bash(docs.dir, 'git commit -m "docs"'), env);
  const md = recsOf(root, 'verify')[2];
  assert.equal(md.decision, 'allow'); assert.equal(md.why, 'docs-only');
  assert.equal(md.docs_only, true); assert.equal(md.candidates, 1);
  const other = dirty('Self-GraphDB', 'agents/keeper.sh');
  assert.equal(runHook('pre-tool.mjs', bash(other.dir, 'git commit -m "x"'), env).stdout.trim(), '');
  assert.equal(recsOf(root, 'verify').length, 3);
});

test('an overridden commit records the candidate count it carried, not an ambiguous null', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  assert.equal(runHook('pre-tool.mjs', bash(dir, 'SKIP_VERIFY=1 git commit -m "hotfix: prod is down"'), env).stdout.trim(), '');
  const [rec] = recsOf(root, 'verify');
  assert.equal(rec.type, 'gate'); assert.equal(rec.decision, 'allow');
  assert.equal(rec.why, 'override SKIP_VERIFY');
  // null is reserved for "git could not list them", so an override stays comparable with the
  // denies around it instead of reading as an unlistable commit.
  assert.equal(rec.candidates, 1);
  assert.equal(rec.docs_only, false);
  assert.equal(rec.marker_ts, null);
});

test('an in-scope gate rule with no skill still denies, and the buffer it lacks is logged', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  const rules = JSON.parse(fs.readFileSync(env.ROUTER_RULES, 'utf8'));
  delete rules.rules.find((x) => x.id === 'verify-commit-gate').skill;
  const file = path.join(root, 'rules.json'); fs.writeFileSync(file, JSON.stringify(rules));
  const r = runHook('pre-tool.mjs', bash(dir, 'git commit -m "feat"'), { ...env, ROUTER_RULES: file });
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(logOf(root), /\trecords\tverify-commit-gate\tportfolio-html\trecord-skipped\trule has no skill/);
  assert.deepEqual(recsOf(root, 'verify'), []);
});

// The gated repository names live in the local override, so one that will not parse ungates every
// one of them. The gate cannot invent them back; what it must never do is go quiet about it.
test('a local override that does not parse ungates the repos it named, and leaves the why in the log', () => {
  const { root, env } = testEnv();
  const { dir } = dirty('portfolio-html');
  fs.writeFileSync(path.join(root, 'skill-rules.local.json'), '{ not json');
  const r = runHook('pre-tool.mjs', bash(dir, 'git commit -m "feat"'), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  const log = logOf(root);
  assert.match(log, /\trules\t-\t-\trules-load-failed\t.*skill-rules\.local\.json/);
  assert.match(log, /\tcommit\t-\tportfolio-html\tallow\tout-of-scope/);
});

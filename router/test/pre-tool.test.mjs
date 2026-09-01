// ~/claude-skills/router/test/pre-tool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHook, testEnv, makeRepo, hookInput } from './helpers.mjs';
import { loadRules } from '../lib/rules.mjs';

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
  assert.equal(runHook('pre-tool.mjs', null, env).stdout.trim(), '');
  assert.equal(runHook('pre-tool.mjs', hookInput({ cwd: dir, tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'web/components/New.tsx') } }), env).stdout.trim(), '');
  assert.equal(runHook('pre-tool.mjs', bash(dir, 'ls -la && git status'), env).stdout.trim(), '');
});

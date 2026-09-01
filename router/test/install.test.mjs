// ~/claude-skills/router/test/install.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routerDir, tmpDir, testEnv } from './helpers.mjs';

const run = (args, env = process.env) => spawnSync('node', [path.join(routerDir, 'install.mjs'), ...args], { encoding: 'utf8', env });
const seed = () => {
  const dir = tmpDir('settings-');
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    permissions: { allow: ['Skill(explain-diff)'], additionalDirectories: ['~/Self-GraphDB'] },
    model: 'claude-fable-5[1m]',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/foreign-hook.sh' }] }] },
  }, null, 2) + '\n');
  return { dir, file };
};

test('install merges hooks/allow/env, keeps foreign entries, writes a backup, and is idempotent', () => {
  const { dir, file } = seed();
  const r = run(['--settings', file]);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.model, 'claude-fable-5[1m]');
  assert.deepEqual(s.permissions.allow, ['Skill(explain-diff)', 'Skill(verify)', 'Skill(reuse-scout)']);
  assert.deepEqual(s.permissions.additionalDirectories, ['~/Self-GraphDB']);
  assert.ok(s.env.SKILL_RUNS_DIR.endsWith(path.join('.claude', 'skill-runs')));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, '/usr/local/bin/foreign-hook.sh');
  const ours = s.hooks.PreToolUse[1];
  assert.equal(ours.matcher, 'Bash|Write');
  assert.deepEqual(ours.hooks, [{ type: 'command', command: `node ${routerDir}/pre-tool.mjs`, timeout: 5 }]);
  assert.equal(s.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, `node ${routerDir}/on-prompt.mjs`);
  assert.equal(s.hooks.PostToolUse[0].matcher, 'Skill');
  assert.equal(s.hooks.PostToolUse[0].hooks[0].command, `node ${routerDir}/post-skill.mjs`);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, 1);
  const again = run(['--settings', file]);
  assert.match(again.stdout, /nothing to change/);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')).length, 1);
});

test('dry-run writes nothing; uninstall removes only our entries', () => {
  const { file } = seed();
  const before = fs.readFileSync(file, 'utf8');
  const d = run(['--settings', file, '--dry-run']);
  assert.match(d.stdout, /dry-run/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  run(['--settings', file]);
  const u = run(['--settings', file, '--uninstall']);
  assert.equal(u.status, 0);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.permissions.allow, ['Skill(explain-diff)']);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.UserPromptSubmit, undefined);
  assert.equal(s.hooks.PostToolUse, undefined);
  assert.equal(s.env, undefined);
});

test('a missing settings file is created; an unparseable one is refused', () => {
  const dir = tmpDir('settings-');
  const file = path.join(dir, 'settings.json');
  assert.equal(run(['--settings', file]).status, 0);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse);
  fs.writeFileSync(file, '{ not json');
  const r = run(['--settings', file]);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('uninstall keeps a foreign hook that shares an entry with ours', () => {
  const { env } = testEnv();
  const { file } = seed();
  run(['--settings', file], env);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ours = s.hooks.PreToolUse.find((e) => e.matcher === 'Bash|Write');
  ours.hooks.push({ type: 'command', command: '/usr/local/bin/IMPORTANT-foreign.sh' });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  const u = run(['--settings', file, '--uninstall'], env);
  assert.equal(u.status, 0);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kept = after.hooks.PreToolUse.find((e) => e.matcher === 'Bash|Write');
  assert.deepEqual(kept.hooks.map((h) => h.command), ['/usr/local/bin/IMPORTANT-foreign.sh']);
  assert.equal(after.hooks.PreToolUse.length, 2);
});

test('--settings without a path refuses instead of targeting the real file', () => {
  const { env } = testEnv();
  const r = run(['--settings', '--dry-run'], env);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--settings needs a path/);
});

test('uninstall keeps a user-set SKILL_RUNS_DIR', () => {
  const { env } = testEnv();
  const { file } = seed();
  const s0 = JSON.parse(fs.readFileSync(file, 'utf8'));
  s0.env = { SKILL_RUNS_DIR: '/Users/kyounghoonkim/MY-OWN-runs' };
  fs.writeFileSync(file, JSON.stringify(s0, null, 2) + '\n');
  run(['--settings', file], env);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.SKILL_RUNS_DIR, '/Users/kyounghoonkim/MY-OWN-runs');
  const u = run(['--settings', file, '--uninstall'], env);
  assert.match(u.stdout, /kept SKILL_RUNS_DIR/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).env.SKILL_RUNS_DIR, '/Users/kyounghoonkim/MY-OWN-runs');
});

test('--settings=<path> is rejected instead of silently targeting the real file', () => {
  const { env } = testEnv();
  const r = run([`--settings=${path.join(tmpDir('settings-'), 'settings.json')}`, '--dry-run'], env);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--settings <path>/);
});

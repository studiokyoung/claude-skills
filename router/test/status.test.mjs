// ~/claude-skills/router/test/status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routerDir, tmpDir, testEnv, makeRepo, shippedRules, FIXTURE_GROUPS } from './helpers.mjs';

const loaded = shippedRules();
const status = (env, args = []) => {
  const r = spawnSync('node', [path.join(routerDir, 'status.mjs'), ...args], { encoding: 'utf8', env, timeout: 20000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
};

function settingsFor(root, dir = routerDir) {
  return {
    permissions: { allow: [...loaded.allowSkills.map((s) => `Skill(${s})`), 'Skill(explain-diff)', 'Bash(ls:*)'] },
    env: { SKILL_RUNS_DIR: path.join(root, '.claude', 'skill-runs') },
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${dir}/on-prompt.mjs`, timeout: 5 }] }],
      PreToolUse: [{ matcher: 'Bash|Write', hooks: [{ type: 'command', command: `node ${dir}/pre-tool.mjs`, timeout: 5 }] }],
      PostToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: `node ${dir}/post-skill.mjs`, timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: `node ${dir}/selfcheck.mjs`, timeout: 10 }] }],
    },
  };
}
function writeSettings(root, s) {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(s, null, 2) + '\n');
}

test('settings: the four entries, whose checkout they run from, the allow rules, the records dir', () => {
  const { root, env } = testEnv();
  const s = settingsFor(root);
  s.hooks.PostToolUse[0].hooks[0].command = 'node /old/path/router/post-skill.mjs';
  delete s.hooks.SessionStart;
  writeSettings(root, s);
  const j = status(env, ['--json']).json;
  assert.equal(j.settings.path, path.join(root, '.claude', 'settings.json'));
  const byScript = Object.fromEntries(j.settings.hooks.map((h) => [h.script, h]));
  assert.deepEqual(byScript['on-prompt.mjs'], { event: 'UserPromptSubmit', script: 'on-prompt.mjs', found: true, dir: routerDir, this_router: true });
  assert.equal(byScript['post-skill.mjs'].found, true);
  assert.equal(byScript['post-skill.mjs'].this_router, false);
  assert.equal(byScript['post-skill.mjs'].dir, '/old/path/router');
  assert.equal(byScript['selfcheck.mjs'].found, false);
  assert.equal(byScript['selfcheck.mjs'].dir, null);
  assert.deepEqual(j.settings.allow.expected, loaded.allowSkills.map((x) => ({ rule: `Skill(${x})`, present: true })));
  assert.equal(j.settings.allow.other_skill_allows, 1);
  assert.equal(j.settings.skill_runs_dir, path.join(root, '.claude', 'skill-runs'));
  assert.equal(j.router_dir, routerDir);
});

test('rules: the merged groups and one row per rule, with the override that supplied them named', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const j = status(env, ['--json']).json;
  assert.equal(j.rules.ok, true);
  // The shipped table names no repositories; what the card prints is the merged view.
  assert.deepEqual(loaded.repoGroups.web, []);
  assert.deepEqual(j.rules.repo_groups.web, FIXTURE_GROUPS.web);
  assert.deepEqual(j.rules.local, { path: path.join(root, 'skill-rules.local.json'), active: true, groups: ['web', 'corp'], error: null });
  assert.deepEqual(j.rules.rules.map((r) => r.id), loaded.rules.map((r) => r.id));
  const gate = j.rules.rules.find((r) => r.id === 'verify-commit-gate');
  assert.deepEqual(gate, { id: 'verify-commit-gate', skill: 'verify', event: 'pre-commit', repos: 'web', mode: 'block' });
  assert.equal(j.rules.pretooluse_context, 'additionalContext');
  assert.match(status(env, ['--md']).stdout, new RegExp(`local +${path.join(root, 'skill-rules.local.json')} · overrides repo_groups web, corp`));
});

test('no override, and an override that will not parse, are both said out loud', () => {
  const none = testEnv();
  writeSettings(none.root, settingsFor(none.root));
  fs.rmSync(path.join(none.root, 'skill-rules.local.json'));
  const j = status(none.env, ['--json']).json;
  assert.equal(j.rules.local.active, false);
  assert.equal(j.rules.local.error, null);
  assert.deepEqual(j.rules.repo_groups, { web: [], corp: [] });
  assert.match(status(none.env, ['--md']).stdout, /local +none \(/);
  assert.match(status(none.env, ['--md']).stdout, /web: \(empty\)/);

  const torn = testEnv();
  writeSettings(torn.root, settingsFor(torn.root));
  fs.writeFileSync(path.join(torn.root, 'skill-rules.local.json'), '{ not json');
  const broken = status(torn.env, ['--json']).json;
  assert.equal(broken.rules.ok, true, 'the base table still loads');
  assert.equal(broken.rules.local.active, false);
  assert.match(broken.rules.local.error, /skill-rules\.local\.json: /);
  assert.match(status(torn.env, ['--md']).stdout, /local +IGNORED · .*skill-rules\.local\.json/);
});

test('this repo: a gated repo, its marker, and a linked worktree keeping the gate but not the marker', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const gated = FIXTURE_GROUPS.web[0];
  const { dir, git } = makeRepo(gated, { 'web/app/page.tsx': 'x' });
  const main = status(env, ['--json', '--cwd', dir]).json.repo;
  assert.equal(main.name, gated);
  assert.equal(main.gated, true);
  assert.equal(main.rule, 'verify-commit-gate');
  assert.equal(main.marker.path, path.join(dir, '.git', 'verify-pass'));
  assert.equal(main.marker.present, false);

  const wt = path.join(path.dirname(dir), 'wt-probe');
  const added = git('worktree', 'add', wt, '-b', 'probe');
  assert.equal(added.status, 0, added.stderr);
  const linked = status(env, ['--json', '--cwd', wt]).json.repo;
  assert.equal(linked.name, gated, 'a linked worktree keeps its main checkout name');
  assert.equal(linked.gated, true);
  assert.match(linked.marker.path, /\.git\/worktrees\//);
  assert.equal(linked.marker.present, false);

  fs.writeFileSync(linked.marker.path, JSON.stringify({ fingerprint: 'x', ts: new Date(Date.now() - 5000).toISOString() }));
  const marked = status(env, ['--json', '--cwd', wt]).json.repo;
  assert.equal(marked.marker.present, true);
  assert.ok(marked.marker.age_s >= 4 && marked.marker.age_s < 120, `age ${marked.marker.age_s}`);
});

test('an ungated repo and a directory outside git are both reported, never guessed', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const { dir } = makeRepo('Self-GraphDB', { 'me.md': 'x' });
  const inside = status(env, ['--json', '--cwd', dir]).json.repo;
  assert.equal(inside.name, 'Self-GraphDB');
  assert.equal(inside.gated, false);
  assert.equal(inside.rule, null);
  const outside = status(env, ['--json', '--cwd', tmpDir('nogit-')]).json.repo;
  assert.equal(outside.root, null);
  assert.equal(outside.name, null);
  assert.equal(outside.gated, false);
  assert.equal(outside.marker.path, null);
});

test('the log tail reads the rotated file too, oldest first', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'router.log.1'), ['old-1', 'old-2'].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'state', 'router.log'), ['new-1', 'new-2', 'new-3'].join('\n') + '\n');
  const four = status(env, ['--json', '--log', '4']).json.log;
  assert.deepEqual(four.lines, ['old-2', 'new-1', 'new-2', 'new-3']);
  assert.equal(four.rotated, true);
  const two = status(env, ['--json', '--log', '2']).json.log;
  assert.deepEqual(two.lines, ['new-2', 'new-3']);
  const dflt = status(env, ['--json']).json.log;
  assert.equal(dflt.lines.length, 5);
});

test('records: line counts and type counts per file, and no records yet when the dir is absent', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const empty = status(env, ['--json']).json.records;
  assert.equal(empty.present, false);
  assert.deepEqual(empty.files, []);
  assert.match(status(env, ['--md']).stdout, /no records yet/);

  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runs', 'verify.jsonl'), [
    JSON.stringify({ type: 'invoke', ts: '2026-09-01T00:00:00Z', skill: 'verify' }),
    JSON.stringify({ type: 'gate', ts: '2026-09-01T00:01:00Z', skill: 'verify' }),
    JSON.stringify({ type: 'gate', ts: '2026-09-01T00:02:00Z', skill: 'verify' }),
    'torn line that never parsed',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'runs', 'router.jsonl'),
    JSON.stringify({ type: 'health', ts: '2026-09-01T00:03:00Z', ok: false, checks: { settings: false }, ms: 402, failures: [{ check: 'settings', reason: 'SessionStart: selfcheck.mjs not registered' }] }) + '\n');
  const j = status(env, ['--json']).json;
  const verify = j.records.files.find((f) => f.file === 'verify.jsonl');
  assert.equal(verify.lines, 4);
  assert.deepEqual(verify.types, { invoke: 1, gate: 2, unparsed: 1 });
  assert.equal(j.health.ok, false);
  assert.equal(j.health.ms, 402);
  assert.deepEqual(j.health.failures, [{ check: 'settings', reason: 'SessionStart: selfcheck.mjs not registered' }]);
});

test('the md card carries every section and always the session-start caveat, and writes nothing', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const { dir } = makeRepo(FIXTURE_GROUPS.web[0], { 'web/app/page.tsx': 'x' });
  const r = status(env, ['--md', '--cwd', dir]);
  assert.equal(r.status, 0, r.stderr);
  for (const section of ['settings', 'rules', 'repo', 'log', 'records', 'caveats']) assert.match(r.stdout, new RegExp(`^${section}`, 'm'));
  assert.match(r.stdout, /hooks are captured at session start/);
  assert.match(r.stdout, /GATED/);
  assert.equal(fs.existsSync(path.join(root, 'state')), false, 'status must not create the state dir');
  assert.equal(fs.existsSync(path.join(root, 'runs')), false, 'status must not create the records dir');
});

test('a settings file that will not parse, and a rule table that will not load, are said out loud', () => {
  const { root, env } = testEnv();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ not json');
  const broken = path.join(tmpDir('rules-'), 'skill-rules.json');
  fs.writeFileSync(broken, '{ nope');
  const j = status({ ...env, ROUTER_RULES: broken }, ['--json']).json;
  assert.equal(j.settings.ok, false);
  assert.match(j.settings.error, /json/i);
  assert.deepEqual(j.settings.hooks, []);
  assert.equal(j.rules.ok, false);
  assert.ok(j.rules.error);
  assert.equal(j.repo.gated, false);
});

test('an unknown flag is refused', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const r = status(env, ['--everything']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

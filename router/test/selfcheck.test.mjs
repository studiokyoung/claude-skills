// ~/claude-skills/router/test/selfcheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routerDir, tmpDir, testEnv, runHook, hookInput } from './helpers.mjs';
import { loadRules } from '../lib/rules.mjs';

const loaded = loadRules();
const start = (over = {}) => hookInput({ hook_event_name: 'SessionStart', source: 'startup', ...over });

// A settings file in the shape the installer writes, so a check that fails has one cause: the mutation.
function settingsFor(root, dir = routerDir) {
  return {
    permissions: { allow: loaded.allowSkills.map((s) => `Skill(${s})`) },
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

const health = (root) => {
  try { return fs.readFileSync(path.join(root, 'runs', 'router.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); }
  catch { return []; }
};
const context = (r) => {
  const last = (r.stdout || '').trim().split('\n').pop();
  return last ? (JSON.parse(last).hookSpecificOutput || {}).additionalContext || '' : '';
};

test('every check passes: no stdout, an ok health record, an ok log line, under a second', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const r = runHook('selfcheck.mjs', start(), env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  const recs = health(root);
  assert.equal(recs.length, 1);
  const h = recs[0];
  assert.equal(h.type, 'health');
  assert.equal(h.ok, true, JSON.stringify(h.failures));
  assert.deepEqual(Object.keys(h.checks).sort(), ['node', 'probe.on-prompt', 'probe.post-skill', 'probe.pre-tool', 'rules', 'settings']);
  assert.ok(Object.values(h.checks).every(Boolean));
  assert.equal(h.router_dir, routerDir);
  assert.equal(h.failures, undefined);
  // Measured at ~450ms idle (four hook spawns in parallel); the ceiling here is loose because the
  // whole suite runs its twelve files concurrently, which is not a session start.
  assert.ok(h.ms >= 0 && h.ms < 5000, `self-check took ${h.ms}ms`);
  assert.match(fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8'), /\thealth\t-\t-\tok\t6 checks \d+ms/);
});

test('a missing PreToolUse entry fails the settings check and names it in the context line', () => {
  const { root, env } = testEnv();
  const s = settingsFor(root);
  delete s.hooks.PreToolUse;
  writeSettings(root, s);
  const r = runHook('selfcheck.mjs', start(), env);
  assert.equal(r.status, 0, r.stderr);
  const ctx = context(r);
  assert.match(ctx, /^\[skill-router\] self-check FAILED: /);
  assert.match(ctx, /settings/);
  assert.match(ctx, /PreToolUse/);
  assert.match(ctx, /repair with \/skill-router install\.$/);
  const h = health(root).at(-1);
  assert.equal(h.ok, false);
  assert.equal(h.checks.settings, false);
  assert.equal(h.checks['probe.pre-tool'], true);
  assert.ok(h.failures.some((f) => f.check === 'settings' && /PreToolUse/.test(f.reason)));
  // a blocking failure, not an informational note: the flag is what keeps the node check out of the verdict
  assert.deepEqual(h.failures.map((f) => f.informational), [false]);
  assert.match(fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8'), /\thealth\t-\t-\tfail\tsettings/);
});

test('hooks registered from another checkout fail the settings check, probes still pass', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root, '/old/path/router'));
  const r = runHook('selfcheck.mjs', start(), env);
  const ctx = context(r);
  assert.match(ctx, /settings/);
  assert.match(ctx, /\/old\/path\/router/);
  const h = health(root).at(-1);
  assert.equal(h.checks.settings, false);
  assert.equal(h.checks['probe.on-prompt'], true);
});

test('an allow rule the installer would have added is a settings failure', () => {
  const { root, env } = testEnv();
  const s = settingsFor(root);
  s.permissions.allow = [];
  writeSettings(root, s);
  const h = (runHook('selfcheck.mjs', start(), env), health(root).at(-1));
  assert.equal(h.checks.settings, false);
  assert.ok(h.failures.some((f) => f.check === 'settings' && /Skill\(/.test(f.reason)));
});

test('a rules file that does not parse fails the rules check', () => {
  const broken = path.join(tmpDir('rules-'), 'skill-rules.json');
  fs.writeFileSync(broken, '{ not json');
  const { root, env } = testEnv({ ROUTER_RULES: broken });
  writeSettings(root, settingsFor(root));
  const r = runHook('selfcheck.mjs', start(), env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(r), /rules/);
  const h = health(root).at(-1);
  assert.equal(h.checks.rules, false);
  assert.ok(h.failures.some((f) => f.check === 'rules'));
});

test('a rule with an unknown repo group, or a prompt rule with no message, fails the rules check', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(routerDir, 'skill-rules.json'), 'utf8'));
  const withGroup = path.join(tmpDir('rules-'), 'skill-rules.json');
  raw.rules[0].repos = 'nope';
  fs.writeFileSync(withGroup, JSON.stringify(raw));
  const a = testEnv({ ROUTER_RULES: withGroup });
  writeSettings(a.root, settingsFor(a.root));
  runHook('selfcheck.mjs', start(), a.env);
  const ha = health(a.root).at(-1);
  assert.equal(ha.checks.rules, false);
  assert.ok(ha.failures.some((f) => f.check === 'rules' && /nope/.test(f.reason)));

  const raw2 = JSON.parse(fs.readFileSync(path.join(routerDir, 'skill-rules.json'), 'utf8'));
  const noMsg = path.join(tmpDir('rules-'), 'skill-rules.json');
  delete raw2.rules.find((x) => x.event === 'prompt').message;
  fs.writeFileSync(noMsg, JSON.stringify(raw2));
  const b = testEnv({ ROUTER_RULES: noMsg });
  writeSettings(b.root, settingsFor(b.root));
  runHook('selfcheck.mjs', start(), b.env);
  const hb = health(b.root).at(-1);
  assert.equal(hb.checks.rules, false);
  assert.ok(hb.failures.some((f) => f.check === 'rules' && /message/.test(f.reason)));
});

test('a hook script that throws fails its own probe and nothing else', () => {
  const { root, env } = testEnv();
  const copy = path.join(tmpDir('router-copy-'), 'router');
  fs.cpSync(routerDir, copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'on-prompt.mjs'), "throw new Error('probe-broken');\n");
  writeSettings(root, settingsFor(root, copy));
  const r = spawnSync('node', [path.join(copy, 'selfcheck.mjs')], { input: JSON.stringify(start()), encoding: 'utf8', env, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(r), /probe\.on-prompt/);
  const h = health(root).at(-1);
  assert.equal(h.ok, false);
  assert.equal(h.checks['probe.on-prompt'], false);
  assert.equal(h.checks['probe.pre-tool'], true);
  assert.equal(h.checks['probe.post-skill'], true);
  assert.equal(h.router_dir, copy);
});

test('SKILL_ROUTER_SELFCHECK=0 and SKILL_ROUTER_PROBE=1 skip it entirely: no output, no record', () => {
  const off = testEnv({ SKILL_ROUTER_SELFCHECK: '0' });
  writeSettings(off.root, settingsFor(off.root));
  const r = runHook('selfcheck.mjs', start(), off.env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(health(off.root), []);
  assert.equal(fs.existsSync(path.join(off.root, 'state', 'router.log')), false);

  const probe = testEnv({ SKILL_ROUTER_PROBE: '1' });
  writeSettings(probe.root, settingsFor(probe.root));
  assert.equal(runHook('selfcheck.mjs', start(), probe.env).stdout.trim(), '');
  assert.deepEqual(health(probe.root), []);
});

test('a /clear or a compaction does not re-run the probes; startup, resume and a bare payload do', () => {
  for (const source of ['clear', 'compact']) {
    const { root, env } = testEnv();
    writeSettings(root, settingsFor(root));
    const r = runHook('selfcheck.mjs', start({ source }), env);
    assert.equal(r.status, 0, source);
    assert.equal(r.stdout.trim(), '', source);
    assert.deepEqual(health(root), [], `source ${source} must not spend four spawns`);
  }
  const resumed = testEnv();
  writeSettings(resumed.root, settingsFor(resumed.root));
  runHook('selfcheck.mjs', start({ source: 'resume' }), resumed.env);
  assert.equal(health(resumed.root).length, 1);

  // A payload that carries no source at all is still checked, so a bare invocation is never silently
  // skipped by a Claude Code version that does not send one.
  const bare = testEnv();
  writeSettings(bare.root, settingsFor(bare.root));
  const noSource = start();
  delete noSource.source;
  runHook('selfcheck.mjs', noSource, bare.env);
  assert.equal(health(bare.root).length, 1);
});

test('--cli prints a table, exits 0 when green and 1 when not, and writes nothing', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const green = runHook('selfcheck.mjs', null, env, ['--cli']);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /router self-check/);
  assert.match(green.stdout, /probe\.pre-tool/);
  assert.match(green.stdout, /^PASS/m);
  assert.deepEqual(health(root), []);
  assert.equal(fs.existsSync(path.join(root, 'state', 'router.log')), false);

  const s = settingsFor(root);
  delete s.hooks.PostToolUse;
  writeSettings(root, s);
  const red = runHook('selfcheck.mjs', null, env, ['--cli']);
  assert.equal(red.status, 1);
  assert.match(red.stdout, /^FAIL/m);
  assert.match(red.stdout, /PostToolUse/);
  assert.deepEqual(health(root), []);
});

test('a wrong hook event and a missing settings file stay fail-open', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const wrong = runHook('selfcheck.mjs', hookInput({ hook_event_name: 'PreToolUse' }), env);
  assert.equal(wrong.status, 0);
  assert.equal(wrong.stdout.trim(), '');
  assert.deepEqual(health(root), []);

  const bare = testEnv();
  const r = runHook('selfcheck.mjs', start(), bare.env);
  assert.equal(r.status, 0);
  assert.match(context(r), /settings/);
  assert.equal(health(bare.root).at(-1).checks.settings, false);
});

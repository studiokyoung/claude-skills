// ~/claude-skills/router/test/selfcheck.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routerDir, tmpDir, testEnv, runHook, hookInput, shippedRules } from './helpers.mjs';

const loaded = shippedRules();
// testEnv writes the scratch override every env starts with; a case that wants a different one
// (broken, empty, or naming another repo) writes over it before the check runs.
const writeLocal = (root, text) => fs.writeFileSync(path.join(root, 'skill-rules.local.json'), typeof text === 'string' ? text : JSON.stringify(text));
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

test('every check passes: no stdout, an ok health record tagged via hook, an ok log line, inside the hook budget', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const r = runHook('selfcheck.mjs', start(), env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  const recs = health(root);
  assert.equal(recs.length, 1);
  const h = recs[0];
  assert.equal(h.type, 'health');
  assert.equal(h.via, 'hook');
  assert.equal(h.ok, true, JSON.stringify(h.failures));
  assert.deepEqual(Object.keys(h.checks).sort(), ['node', 'probe.on-prompt', 'probe.post-skill', 'probe.pre-tool', 'rules', 'settings']);
  assert.ok(Object.values(h.checks).every(Boolean));
  assert.equal(h.router_dir, routerDir);
  assert.equal(h.failures, undefined);
  // Measured at ~450ms idle (four hook spawns in parallel); the ceiling here is loose because the
  // whole suite runs its twelve files concurrently, which is not a session start.
  // 9s, not 5s: twelve concurrent files plus npm's own parent process measured 6.2s here, and the
  // SessionStart hook budget is 10s, so 9s is the bound that actually means something.
  assert.ok(h.ms >= 0 && h.ms < 9000, `self-check took ${h.ms}ms`);
  assert.match(fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8'), /\thealth\t-\t-\tok\t6 checks \d+ms/);
});

// A scheduled --cli run is the only thing that fills the Health history between sessions, so it has to
// leave the same evidence a session start does, distinguishable from it and counted exactly once.
test('--cli leaves one health record too, tagged via cli', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const r = runHook('selfcheck.mjs', null, env, ['--cli']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^PASS · 6 checks · \d+ms$/m);
  const recs = health(root);
  assert.equal(recs.length, 1, `expected exactly one health record, got ${recs.length}`);
  const h = recs[0];
  assert.equal(h.type, 'health');
  assert.equal(h.via, 'cli');
  assert.equal(h.ok, true, JSON.stringify(h.failures));
  assert.deepEqual(Object.keys(h.checks).sort(), ['node', 'probe.on-prompt', 'probe.post-skill', 'probe.pre-tool', 'rules', 'settings']);
  assert.equal(h.failures, undefined);
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

test('a blocking gate rule with no skill fails the rules check', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(routerDir, 'skill-rules.json'), 'utf8'));
  const gate = raw.rules.find((x) => x.event === 'pre-commit' && x.mode === 'block');
  delete gate.skill;
  const file = path.join(tmpDir('rules-'), 'skill-rules.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  const { root, env } = testEnv({ ROUTER_RULES: file });
  writeSettings(root, settingsFor(root));
  runHook('selfcheck.mjs', start(), env);
  const h = health(root).at(-1);
  assert.equal(h.checks.rules, false);
  assert.ok(h.failures.some((f) => f.check === 'rules' && new RegExp(gate.id).test(f.reason) && /recorded nowhere/.test(f.reason)));
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

test('only /clear and a compaction skip the probes; every other source runs, known or not', () => {
  for (const source of ['clear', 'compact']) {
    const { root, env } = testEnv();
    writeSettings(root, settingsFor(root));
    const r = runHook('selfcheck.mjs', start({ source }), env);
    assert.equal(r.status, 0, source);
    assert.equal(r.stdout.trim(), '', source);
    assert.deepEqual(health(root), [], `source ${source} must not spend four spawns`);
  }

  // A denylist, deliberately. An allowlist would let a source this router has never heard of, a
  // future Claude Code sending `sdk` or nothing at all, switch the check off without saying so, and
  // a self-check that goes quiet for a month is exactly what it exists to prevent.
  const bare = start();
  delete bare.source;
  const runs = [['startup', start()], ['resume', start({ source: 'resume' })], ['null', start({ source: null })],
    ['empty', start({ source: '' })], ['unknown', start({ source: 'sdk' })], ['no source key', bare]];
  for (const [label, payload] of runs) {
    const { root, env } = testEnv();
    writeSettings(root, settingsFor(root));
    runHook('selfcheck.mjs', payload, env);
    assert.equal(health(root).length, 1, `source ${label} must still be checked`);
  }
});

// The gate probe stages its own throwaway checkout with spawnSync, which reports a git that is
// missing, failing or killed at the timeout by RETURNING the failure rather than throwing. Left
// unchecked, the probe commits into a directory that is not a repo and blames the gate for letting
// it through. The self-check may say it could not build the checkout; it may never cry wolf.
test('a git that fails or hangs reads as a checkout that could not be built, never as a gate that let a commit through', () => {
  for (const [label, script] of [['exits 1', '#!/bin/sh\nexit 1\n'], ['hangs past the timeout', '#!/bin/sh\nsleep 10\n']]) {
    const shim = tmpDir('git-shim-');
    fs.writeFileSync(path.join(shim, 'git'), script, { mode: 0o755 });
    fs.chmodSync(path.join(shim, 'git'), 0o755);
    const { root, env } = testEnv({ PATH: `${shim}${path.delimiter}${process.env.PATH}` });
    writeSettings(root, settingsFor(root));
    const r = runHook('selfcheck.mjs', start(), env);
    assert.equal(r.status, 0, `${label}: ${r.stderr}`);
    const h = health(root).at(-1);
    assert.equal(h.checks['probe.pre-tool'], false, label);
    const why = h.failures.find((f) => f.check === 'probe.pre-tool').reason;
    assert.match(why, /could not build a throwaway \S+ checkout to probe with/, label);
    assert.doesNotMatch(why, /was not denied/, label);
    assert.match(context(r), /could not build a throwaway/, label);
  }
});

test('--cli prints a table, exits 0 when green and 1 when not, and records both runs', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  const green = runHook('selfcheck.mjs', null, env, ['--cli']);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  assert.match(green.stdout, /router self-check/);
  assert.match(green.stdout, /probe\.pre-tool/);
  assert.match(green.stdout, /^PASS/m);
  // A --cli run is a real self-check, not a preview: it leaves the same evidence a session start
  // does, one record per run and the log line beside it.
  assert.deepEqual(health(root).map((h) => [h.via, h.ok]), [['cli', true]]);
  assert.equal(fs.existsSync(path.join(root, 'state', 'router.log')), true);

  const s = settingsFor(root);
  delete s.hooks.PostToolUse;
  writeSettings(root, s);
  const red = runHook('selfcheck.mjs', null, env, ['--cli']);
  assert.equal(red.status, 1);
  assert.match(red.stdout, /^FAIL/m);
  assert.match(red.stdout, /PostToolUse/);
  assert.deepEqual(health(root).map((h) => [h.via, h.ok]), [['cli', true], ['cli', false]]);
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

// The one failure mode the override adds: the table still loads, so nothing is loud, while every
// repo whose name lives only in that file is silently ungated. The daily --cli alarm has to catch it.
test('a local override that does not parse fails the rules check and names the file', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  writeLocal(root, '{ not json');
  const r = runHook('selfcheck.mjs', start(), env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(context(r), /skill-rules\.local\.json/);
  const h = health(root).at(-1);
  assert.equal(h.ok, false);
  assert.equal(h.checks.rules, false);
  assert.ok(h.failures.some((f) => f.check === 'rules' && /skill-rules\.local\.json/.test(f.reason) && f.informational === false));
});

// A fresh public checkout gates nothing until its owner adds names. Nothing is broken, so the gate
// probe says so and stands aside; a failure here would cry wolf on every first install.
test('an empty merged gate group is an informational note, never a failure', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  writeLocal(root, { repo_groups: { web: [], corp: [] } });
  const r = runHook('selfcheck.mjs', null, env, ['--cli']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /⚠️ probe\.pre-tool\s+no gated repos configured; commit-gate probe skipped/);
  assert.match(r.stdout, /^PASS · 6 checks · \d+ms · 1 note$/m);
  const h = health(root).at(-1);
  assert.equal(h.ok, true);
  assert.equal(h.checks['probe.pre-tool'], false);
  assert.ok(h.failures.some((f) => f.check === 'probe.pre-tool' && f.informational === true));
});

// The probe hardcodes no repository name: it stages whatever the merged table gates first, so the
// same check proves the gate on a machine whose names the shipped table has never heard of.
test('the gate probe stages the repo the merged table names, and the card says the override is on', () => {
  const { root, env } = testEnv();
  writeSettings(root, settingsFor(root));
  writeLocal(root, { repo_groups: { web: ['scratch-gate-repo'], corp: [] } });
  const r = runHook('selfcheck.mjs', null, env, ['--cli']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /probe\.pre-tool\s+new-file reminder \+ commit deny in scratch-gate-repo/);
  assert.match(r.stdout, /rules\s+4 rules, 2 groups, additionalContext · local override \(web, corp\)/);
  assert.match(r.stdout, /^PASS/m);
});

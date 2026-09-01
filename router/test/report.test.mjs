// ~/claude-skills/router/test/report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routerDir, testEnv } from './helpers.mjs';

const report = (env, args = []) => {
  const r = spawnSync('node', [path.join(routerDir, 'report.mjs'), ...args], { encoding: 'utf8', env, timeout: 20000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
};
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

function write(env, skill, lines) {
  const dir = env.SKILL_RUNS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${skill}.jsonl`), lines.map((l) => JSON.stringify({ skill, ...l })).join('\n') + '\n');
}

test('invokes, reminders and conversion are counted per skill and per rule', () => {
  const { env } = testEnv();
  write(env, 'reuse-scout', [
    // s1: reminded, then ran → converted
    { type: 'remind', ts: ago(50), rule: 'reuse-scout-prompt', delivery: 'prompt', session_id: 's1', pattern_index: 1, prompt_excerpt: '버튼 컴포넌트 하나 만들어줘' },
    { type: 'invoke', ts: ago(49), session_id: 's1', trigger: 'router' },
    // s2: reminded twice, never ran
    { type: 'remind', ts: ago(40), rule: 'reuse-scout-prompt', delivery: 'prompt', session_id: 's2', pattern_index: 0, prompt_excerpt: 'add a useDebounce hook' },
    { type: 'remind', ts: ago(39), rule: 'reuse-scout-new-file', delivery: 'new-file', session_id: 's2', target: 'web/components/Toast.tsx' },
    // s3: an invoke BEFORE the reminder does not convert it
    { type: 'invoke', ts: ago(30), session_id: 's3', trigger: 'model' },
    { type: 'remind', ts: ago(29), rule: 'reuse-scout-prompt', delivery: 'prompt', session_id: 's3', pattern_index: 0, prompt_excerpt: 'create a modal' },
    // a run in another session converts nothing here
    { type: 'run', ts: ago(20), session_id: 's9', version: '1.1.0', outcome: { verdict: 'done' }, caught: [] },
  ]);
  write(env, 'verify', [{ type: 'invoke', ts: ago(10), session_id: 's1', trigger: 'user' }]);
  const r = report(env, ['--json']);
  assert.equal(r.status, 0, r.stderr);
  const rs = r.json.skills['reuse-scout'];
  assert.deepEqual(rs.invoke, { total: 2, user: 0, router: 1, model: 1 });
  assert.equal(rs.remind.total, 4);
  assert.equal(rs.remind.converted, 1);
  assert.equal(rs.remind.rate, 0.25);
  assert.equal(rs.remind.rules['reuse-scout-prompt'].total, 3);
  assert.equal(rs.remind.rules['reuse-scout-prompt'].converted, 1);
  assert.deepEqual(rs.remind.rules['reuse-scout-prompt'].unconverted, ['create a modal', 'add a useDebounce hook']);
  assert.equal(rs.remind.rules['reuse-scout-new-file'].converted, 0);
  assert.deepEqual(r.json.skills.verify.invoke, { total: 1, user: 1, router: 0, model: 0 });
  assert.equal(r.json.totals.remind, 4);
  assert.equal(r.json.totals.invoke, 3);
});

test('runs aggregate by verdict, version, gate status, numeric outcome and caught items', () => {
  const { env } = testEnv();
  write(env, 'verify', [
    { type: 'run', ts: ago(30), version: '1.1.0', session_id: 'a', outcome: { verdict: 'safe', gates: { git: 'PASS', typecheck: 'PASS', tests: 'PASS', screenshots: 'SKIP' }, tiles: 9, duration_s: 84 }, caught: [] },
    { type: 'run', ts: ago(20), version: '1.1.0', session_id: 'a', outcome: { verdict: 'not-safe', gates: { git: 'PASS', typecheck: 'FAIL', tests: 'PASS', screenshots: 'PASS' }, tiles: 6, duration_s: 61 }, caught: ['typecheck: 3 errors'] },
    { type: 'run', ts: ago(10), version: '1.2.0', session_id: 'b', outcome: { verdict: 'safe', gates: { git: 'PASS' }, tiles: 3 }, caught: ['tests: flake'] },
  ]);
  const v = report(env, ['--json']).json.skills.verify.run;
  assert.equal(v.total, 3);
  assert.deepEqual(v.verdicts, { safe: 2, 'not-safe': 1 });
  assert.deepEqual(v.versions['1.1.0'], { total: 2, verdicts: { safe: 1, 'not-safe': 1 } });
  assert.deepEqual(v.gates.typecheck, { PASS: 1, FAIL: 1 });
  assert.deepEqual(v.gates.screenshots, { SKIP: 1, PASS: 1 });
  assert.equal(v.outcome_sums.tiles, 18);
  assert.equal(v.outcome_sums.duration_s, 145);
  assert.equal(v.caught_total, 2);
  assert.deepEqual(v.caught, ['typecheck: 3 errors', 'tests: flake']);
});

test('gate lines: allow/deny by why, deny to allow cycles, medians, SKIP_VERIFY overrides', () => {
  const { env } = testEnv();
  write(env, 'verify', [
    // session a: deny, deny, allow (marker age 100) → one cycle, 2 denies before the first allow
    { type: 'gate', ts: ago(50), session_id: 'a', decision: 'deny', why: 'marker missing', marker_age_s: null, command_excerpt: 'git commit -m a' },
    { type: 'gate', ts: ago(49), session_id: 'a', decision: 'deny', why: 'marker missing', marker_age_s: null, command_excerpt: 'git commit -m a' },
    { type: 'gate', ts: ago(48), session_id: 'a', decision: 'allow', why: 'verified 2026-08-30', marker_age_s: 100, command_excerpt: 'git commit -m a' },
    // session b: deny, allow (marker age 40) → one cycle, 1 deny before the first allow
    { type: 'gate', ts: ago(40), session_id: 'b', decision: 'deny', why: 'tree changed since 2026-08-29', marker_age_s: null, command_excerpt: 'git commit -m b' },
    { type: 'gate', ts: ago(39), session_id: 'b', decision: 'allow', why: 'verified 2026-08-30', marker_age_s: 40, command_excerpt: 'git commit -m b' },
    // an allow with no deny behind it is not a cycle
    { type: 'gate', ts: ago(30), session_id: 'c', decision: 'allow', why: 'docs-only', marker_age_s: null, command_excerpt: 'git commit -m docs' },
    { type: 'gate', ts: ago(20), session_id: 'c', decision: 'allow', why: 'override SKIP_VERIFY', marker_age_s: null, command_excerpt: 'SKIP_VERIFY=1 git commit -m rush' },
  ]);
  const g = report(env, ['--json']).json.skills.verify.gate;
  assert.equal(g.total, 7);
  assert.deepEqual(g.deny, { 'marker missing': 2, 'tree changed since 2026-08-29': 1 });
  assert.equal(g.allow['verified 2026-08-30'], 2);
  assert.equal(g.allow['docs-only'], 1);
  assert.equal(g.cycles.count, 2);
  assert.equal(g.cycles.median_marker_age_s, 70);
  assert.equal(g.cycles.median_denies_before_first_allow, 1.5);
  assert.equal(g.overrides.count, 1);
  assert.deepEqual(g.overrides.commands, ['SKIP_VERIFY=1 git commit -m rush']);
});

test('annotations and health records are reported', () => {
  const { env } = testEnv();
  write(env, 'verify', [
    { type: 'annotation', ts: ago(10), ref: 'verify-1', missed: 'carousel mobile overflow', by: 'debrief' },
    { type: 'annotation', ts: ago(9), ref: 'verify-2', caught: 'tests: flake', by: 'debrief' },
  ]);
  write(env, 'router', [
    { type: 'health', ts: ago(30), ok: true, checks: { settings: true }, ms: 400 },
    { type: 'health', ts: ago(5), ok: false, checks: { settings: false }, ms: 380, failures: [{ check: 'settings', reason: 'PreToolUse: pre-tool.mjs not registered' }] },
  ]);
  const j = report(env, ['--json']).json;
  assert.deepEqual(j.skills.verify.annotation.missed, [{ ref: 'verify-1', text: 'carousel mobile overflow', by: 'debrief' }]);
  assert.deepEqual(j.skills.verify.annotation.caught, [{ ref: 'verify-2', text: 'tests: flake', by: 'debrief' }]);
  assert.equal(j.skills.router, undefined);
  assert.deepEqual(j.health.ok, 1);
  assert.deepEqual(j.health.fail, 1);
  assert.deepEqual(j.health.last_failures, [{ check: 'settings', reason: 'PreToolUse: pre-tool.mjs not registered' }]);
});

test('candidates are derived, not guessed', () => {
  const { env } = testEnv();
  write(env, 'reuse-scout', [
    { type: 'remind', ts: ago(50), rule: 'reuse-scout-prompt', delivery: 'prompt', session_id: 'x1', pattern_index: 0, prompt_excerpt: 'add a hook' },
    { type: 'remind', ts: ago(49), rule: 'reuse-scout-prompt', delivery: 'prompt', session_id: 'x2', pattern_index: 0, prompt_excerpt: 'add a util' },
    { type: 'remind', ts: ago(48), rule: 'reuse-scout-prompt', delivery: 'prompt', session_id: 'x3', pattern_index: 0, prompt_excerpt: '/reuse-scout 컴포넌트 만들어줘' },
  ]);
  write(env, 'verify', [
    { type: 'gate', ts: ago(40), session_id: 'g1', decision: 'deny', why: 'marker missing', command_excerpt: 'git commit -m x' },
    { type: 'gate', ts: ago(39), session_id: 'g1', decision: 'deny', why: 'marker missing', command_excerpt: 'git commit -m x' },
    { type: 'gate', ts: ago(38), session_id: 'g1', decision: 'deny', why: 'marker missing', command_excerpt: 'git commit -m x' },
    { type: 'run', ts: ago(20), version: '2.0.0', session_id: 'g2', outcome: { verdict: 'not-safe' }, caught: [] },
    { type: 'run', ts: ago(19), version: '2.0.0', session_id: 'g2', outcome: { verdict: 'not-safe' }, caught: [] },
    { type: 'run', ts: ago(18), version: '2.0.0', session_id: 'g2', outcome: { verdict: 'safe' }, caught: [] },
  ]);
  const kinds = report(env, ['--json']).json.candidates;
  const of = (kind) => kinds.filter((c) => c.kind === kind);
  assert.equal(of('rule-never-converts').length, 1);
  assert.match(of('rule-never-converts')[0].subject, /reuse-scout-prompt/);
  assert.equal(of('gate-loop').length, 1);
  assert.match(of('gate-loop')[0].detail, /3 denies/);
  assert.equal(of('self-echo').length, 1);
  assert.match(of('self-echo')[0].detail, /\/reuse-scout/);
  assert.equal(of('version-regression').length, 1);
  assert.match(of('version-regression')[0].subject, /verify 2\.0\.0/);
  // pattern 1 of the prompt rule never fired in this window; pattern 0 did
  const unused = of('pattern-unused').map((c) => c.subject);
  assert.ok(unused.includes('reuse-scout-prompt #1'), unused.join(','));
  assert.ok(!unused.includes('reuse-scout-prompt #0'), unused.join(','));
});

test('the window comes from --since, then the watermark, then the last seven days', () => {
  const { env } = testEnv();
  write(env, 'verify', [
    { type: 'invoke', ts: ago(24 * 30), session_id: 'old', trigger: 'user' },
    { type: 'invoke', ts: ago(24 * 3), session_id: 'mid', trigger: 'user' },
    { type: 'invoke', ts: ago(2), session_id: 'new', trigger: 'user' },
  ]);
  const dflt = report(env, ['--json']).json;
  assert.equal(dflt.window.source, 'default');
  assert.equal(dflt.skills.verify.invoke.total, 2);

  const since = report(env, ['--json', '--since', ago(24)]).json;
  assert.equal(since.window.source, 'since');
  assert.equal(since.skills.verify.invoke.total, 1);

  fs.mkdirSync(env.ROUTER_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.ROUTER_STATE_DIR, 'review-watermark.json'), JSON.stringify({ last: ago(24 * 40) }));
  const wm = report(env, ['--json']).json;
  assert.equal(wm.window.source, 'watermark');
  assert.equal(wm.skills.verify.invoke.total, 3);
});

test('--mark writes the watermark and reports the one it replaced', () => {
  const { env } = testEnv();
  const before = Date.now();
  const r = report(env, ['--mark']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^marked /m);
  assert.match(r.stdout, /previous: none/);
  const wm = JSON.parse(fs.readFileSync(path.join(env.ROUTER_STATE_DIR, 'review-watermark.json'), 'utf8'));
  assert.ok(Date.parse(wm.last) >= before);
  const again = report(env, ['--mark']);
  assert.match(again.stdout, new RegExp(`previous: ${wm.last.replace(/[.+]/g, '\\$&')}`));
  // a report asked for alongside the mark is still printed
  const both = report(env, ['--json', '--mark']);
  assert.ok(both.json.marked);
});

test('an empty window is a clean report, not an error', () => {
  const { env } = testEnv();
  const md = report(env, ['--md']);
  assert.equal(md.status, 0, md.stderr);
  assert.match(md.stdout, /nothing this week/i);
  assert.doesNotMatch(md.stdout, /## Candidates/);
  const j = report(env, ['--json']).json;
  assert.deepEqual(j.skills, {});
  assert.deepEqual(j.candidates, []);
  assert.equal(j.totals.records, 0);
});

test('markdown carries the window, a section per skill, candidates and health', () => {
  const { env } = testEnv();
  write(env, 'verify', [
    { type: 'invoke', ts: ago(5), session_id: 'a', trigger: 'user' },
    { type: 'run', ts: ago(4), version: '1.1.0', session_id: 'a', outcome: { verdict: 'not-safe', gates: { tests: 'FAIL' } }, caught: ['tests: 1 suite'] },
    { type: 'gate', ts: ago(3), session_id: 'a', decision: 'deny', why: 'marker missing', command_excerpt: 'git commit -m x' },
  ]);
  write(env, 'router', [{ type: 'health', ts: ago(2), ok: true, checks: { settings: true }, ms: 402 }]);
  const md = report(env).stdout;
  assert.match(md, /^# skill router . weekly review/m);
  assert.match(md, /^window /m);
  assert.match(md, /^## verify$/m);
  assert.match(md, /^## Candidates$/m);
  assert.match(md, /^## Health$/m);
  assert.match(md, /not-safe/);
  assert.match(md, /marker missing/);
  assert.match(md, /tests: 1 suite/);
});

test('a bad --since and an unknown flag are refused', () => {
  const { env } = testEnv();
  const bad = report(env, ['--since', 'last tuesday']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--since/);
  const unknown = report(env, ['--weekly']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage/);
});

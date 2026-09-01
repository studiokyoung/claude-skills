// ~/claude-skills/router/test/record-run.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHook, testEnv, makeRepo, routerDir, tmpDir } from './helpers.mjs';
import { readMarker } from '../lib/git.mjs';

const runsOf = (root, skill) => fs.readFileSync(path.join(root, 'runs', `${skill}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('run record: version from --skill-md, repo from --cwd, outcome/caught split, session inferred from ledger', () => {
  const { root, env } = testEnv();
  const { dir } = makeRepo('portfolio-html');
  const md = path.join(root, 'SKILL.md');
  fs.writeFileSync(md, '---\nname: verify\nmetadata:\n  version: "1.1.0"\n---\n');
  spawnSync('node', ['--input-type=module', '-e', `import { loadLedger, saveLedger } from './lib/ledger.mjs'; const l = loadLedger('sess-42'); l.repo = 'portfolio-html'; saveLedger(l);`], { env, cwd: routerDir, encoding: 'utf8' });
  const r = runHook('record-run.mjs', null, env, ['--skill', 'verify', '--cwd', dir, '--skill-md', md, '--json', '{"verdict":"safe","gates":{"git":"PASS"},"tiles":3,"caught":["tests: x failed"]}']);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.file, path.join(root, 'runs', 'verify.jsonl'));
  const [rec] = runsOf(root, 'verify');
  assert.equal(rec.id, r.json.id);
  assert.equal(rec.type, 'run'); assert.equal(rec.skill, 'verify'); assert.equal(rec.version, '1.1.0');
  assert.equal(rec.repo, 'portfolio-html'); assert.equal(rec.cwd, dir);
  assert.deepEqual(rec.outcome, { verdict: 'safe', gates: { git: 'PASS' }, tiles: 3 });
  assert.deepEqual(rec.caught, ['tests: x failed']);
  assert.equal(rec.session_id, 'sess-42'); assert.equal(rec.session_inferred, true);
});

test('run record without a ledger: session_id null; --version overrides; caught defaults to []', () => {
  const { root, env } = testEnv();
  const { dir } = makeRepo('other-repo');
  const r = runHook('record-run.mjs', null, env, ['--skill', 'reuse-scout', '--cwd', dir, '--version', '9.9.9', '--json', '{"capabilities":2,"reuse":1,"partial":0,"new":1}']);
  const [rec] = runsOf(root, 'reuse-scout');
  assert.equal(r.json.ok, true);
  assert.equal(rec.session_id, null); assert.equal(rec.session_inferred, false);
  assert.equal(rec.version, '9.9.9'); assert.deepEqual(rec.caught, []);
  assert.deepEqual(rec.outcome, { capabilities: 2, reuse: 1, partial: 0, new: 1 });
});

test('annotation: requires ref, records missed/by/note', () => {
  const { root, env } = testEnv();
  const bad = runHook('record-run.mjs', null, env, ['--skill', 'verify', '--type', 'annotation', '--json', '{"missed":"x"}']);
  assert.deepEqual(bad.json, { ok: false, reason: 'missing ref' });
  const ok = runHook('record-run.mjs', null, env, ['--skill', 'verify', '--type', 'annotation', '--json', '{"ref":"verify-20260830T120000Z-ab12","missed":"carousel mobile overflow","by":"debrief 2026-09-02","note":"tiles were desktop-only"}']);
  assert.equal(ok.json.ok, true);
  const [rec] = runsOf(root, 'verify');
  assert.equal(rec.type, 'annotation'); assert.equal(rec.ref, 'verify-20260830T120000Z-ab12');
  assert.equal(rec.missed, 'carousel mobile overflow'); assert.equal(rec.by, 'debrief 2026-09-02');
});

test('errors never throw: missing --skill, invalid --json', () => {
  const { env } = testEnv();
  assert.deepEqual(runHook('record-run.mjs', null, env, ['--json', '{}']).json, { ok: false, reason: 'missing --skill' });
  const r = runHook('record-run.mjs', null, env, ['--skill', 'verify', '--json', 'not json']);
  assert.deepEqual(r.json, { ok: false, reason: 'invalid --json' }); assert.equal(r.status, 0);
});

test('shims: the skill-local entry points run the router CLIs', () => {
  const { root, env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'x' });
  const shimRecord = path.join(routerDir, '..', 'skills', 'verify', 'references', 'record-run.mjs');
  const shimMark = path.join(routerDir, '..', 'skills', 'verify', 'references', 'mark-pass.mjs');
  const shimScout = path.join(routerDir, '..', 'skills', 'reuse-scout', 'references', 'record-run.mjs');
  const a = spawnSync('node', [shimRecord, '--skill', 'verify', '--cwd', dir, '--json', '{"verdict":"not-safe"}'], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(a.stdout.trim()).ok, true);
  const b = spawnSync('node', [shimMark, '--root', dir], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(b.stdout.trim()).ok, true);
  assert.ok(readMarker(dir));
  const c = spawnSync('node', [shimScout, '--skill', 'reuse-scout', '--cwd', dir, '--json', '{"capabilities":1}'], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(c.stdout.trim()).ok, true);
  assert.equal(runsOf(root, 'verify').length, 1);
  assert.equal(runsOf(root, 'reuse-scout').length, 1);
});

test('record-run: a write failure is reported, a non-array caught is wrapped, the name is sanitized', () => {
  const { root, env } = testEnv();
  const { dir } = makeRepo('portfolio-html');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'runs'), 'not a directory');
  const bad = runHook('record-run.mjs', null, env, ['--skill', 'verify', '--cwd', dir, '--json', '{"verdict":"safe"}']);
  assert.equal(bad.status, 0);
  assert.deepEqual(bad.json, { ok: false, reason: 'write-failed' });
  const second = testEnv();
  const ok = runHook('record-run.mjs', null, second.env, ['--skill', 'kyoung:verify', '--cwd', dir, '--json', '{"verdict":"safe","caught":"tests: one failed"}']);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.file, path.join(second.root, 'runs', 'verify.jsonl'));
  assert.deepEqual(runsOf(second.root, 'verify')[0].caught, ['tests: one failed']);
});

test('run record carries the git context of --cwd and an optional prompt id; nulls outside a repo', () => {
  const { root, env } = testEnv();
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'x' });
  fs.writeFileSync(path.join(dir, 'web/app/page.tsx'), 'y');
  const r = runHook('record-run.mjs', null, env, ['--skill', 'verify', '--cwd', dir, '--prompt-id', 'p42', '--json', '{"verdict":"safe"}']);
  assert.equal(r.json.ok, true);
  const [rec] = runsOf(root, 'verify');
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.equal(rec.git.head, g('rev-parse', 'HEAD').slice(0, 12));
  assert.equal(rec.git.branch, g('rev-parse', '--abbrev-ref', 'HEAD'));
  assert.equal(rec.git.changed, 1);
  assert.equal(rec.prompt_id, 'p42');
  const outside = testEnv();
  runHook('record-run.mjs', null, outside.env, ['--skill', 'verify', '--cwd', tmpDir('nogit-'), '--json', '{"verdict":"safe"}']);
  const [bare] = runsOf(outside.root, 'verify');
  assert.deepEqual(bare.git, { head: null, branch: null, changed: null });
  assert.equal(bare.prompt_id, null);
  assert.equal(bare.repo, null);
  // A repo with no commit yet: head is null, never the 'EMPTY' sentinel git.mjs uses internally,
  // which would sit in the record where a commit id belongs. changed still counts, so an unborn
  // repo stays distinguishable from no repo at all.
  const unborn = testEnv();
  const fresh = tmpDir('unborn-');
  spawnSync('git', ['init', '-q'], { cwd: fresh });
  fs.writeFileSync(path.join(fresh, 'a.txt'), 'x');
  runHook('record-run.mjs', null, unborn.env, ['--skill', 'verify', '--cwd', fresh, '--json', '{"verdict":"safe"}']);
  const [empty] = runsOf(unborn.root, 'verify');
  assert.deepEqual(empty.git, { head: null, branch: null, changed: 1 });
});

// ~/claude-skills/router/test/ledger-records.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routerDir, testEnv } from './helpers.mjs';

const node = (code, env, input = '') => spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8', env, cwd: routerDir, input });

test('ledger: load default, save, hasRun/wasReminded, prune old files', () => {
  const { root, env } = testEnv();
  const r = node(`
    import { loadLedger, saveLedger, hasRun, wasReminded, ledgerFile } from './lib/ledger.mjs';
    const l = loadLedger('s1');
    l.repo = 'portfolio-html';
    l.reminded['reuse-scout-prompt'] = { skill: 'reuse-scout', prompt_id: 'p1', ts: 'now' };
    l.user_invoked.push({ skill: 'verify', prompt_id: 'p2', ts: 'now' });
    saveLedger(l);
    const again = loadLedger('s1');
    console.log(JSON.stringify([again.repo, hasRun(again, 'verify'), hasRun(again, 'reuse-scout'), wasReminded(again, 'reuse-scout'), wasReminded(again, 'verify'), ledgerFile('s1')]));
  `, env);
  const [repo, ranV, ranR, remR, remV, file] = JSON.parse(r.stdout);
  assert.equal(repo, 'portfolio-html');
  assert.equal(ranV, true); assert.equal(ranR, false);
  assert.equal(remR, true); assert.equal(remV, false);
  assert.equal(file, path.join(root, 'state', 's1.json'));
  const old = path.join(root, 'state', 'old.json');
  fs.writeFileSync(old, '{}');
  const past = new Date(Date.now() - 10 * 864e5);
  fs.utimesSync(old, past, past);
  node(`import { loadLedger, saveLedger } from './lib/ledger.mjs'; saveLedger(loadLedger('s2'));`, env);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(root, 'state', 's1.json')), true);
});

test('records: appendRecord writes one JSON line with id/ts/skill and returns it', () => {
  const { root, env } = testEnv();
  const r = node(`
    import { appendRecord, newId } from './lib/records.mjs';
    const a = appendRecord('verify', { type: 'run', repo: 'portfolio-html', outcome: { verdict: 'safe' }, caught: [] });
    const b = appendRecord('verify', { type: 'invoke', repo: 'portfolio-html', trigger: 'user' });
    console.log(JSON.stringify([a, b, newId('verify')]));
  `, env);
  const [a, b, id] = JSON.parse(r.stdout);
  const lines = fs.readFileSync(path.join(root, 'runs', 'verify.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).id, a.id);
  assert.equal(a.type, 'run'); assert.equal(a.skill, 'verify');
  assert.match(a.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/);
  assert.match(id, /^verify-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
  assert.equal(b.trigger, 'user');
});

test('records: normalizeSkill / skillFromToolInput / readSkillVersion / inferSession', () => {
  const { root, env } = testEnv();
  const skillsRoot = path.join(root, 'skills');
  fs.mkdirSync(path.join(skillsRoot, 'verify'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'verify', 'SKILL.md'), '---\nname: verify\nmetadata:\n  version: "1.1.0"\n---\nbody\n');
  const r = node(`
    import { normalizeSkill, skillFromToolInput, readSkillVersion, inferSession } from './lib/records.mjs';
    import { loadLedger, saveLedger } from './lib/ledger.mjs';
    const l = loadLedger('sX'); l.repo = 'portfolio-html'; saveLedger(l);
    console.log(JSON.stringify([
      normalizeSkill(' kyoung:verify '), normalizeSkill('reuse-scout'),
      skillFromToolInput({ skill: 'kyoung:reuse-scout', args: 'x' }), skillFromToolInput({ name: 'verify' }), skillFromToolInput({}), skillFromToolInput(null),
      readSkillVersion('verify', ${JSON.stringify(path.join(skillsRoot, 'verify', 'SKILL.md'))}), readSkillVersion('nope'),
      inferSession('portfolio-html'), inferSession('other-repo'),
    ]));
  `, env);
  const v = JSON.parse(r.stdout);
  assert.deepEqual(v.slice(0, 2), ['verify', 'reuse-scout']);
  assert.deepEqual(v.slice(2, 6), ['reuse-scout', 'verify', null, null]);
  assert.equal(v[6], '1.1.0'); assert.equal(v[7], null);
  assert.deepEqual(v[8], { session_id: 'sX', inferred: true });
  assert.equal(v[9], null);
});

test('appendRecord: defaults are authoritative and skill cannot be overridden; filename is sanitized', () => {
  const { root, env } = testEnv();
  const r = node(`
    import { appendRecord } from './lib/records.mjs';
    const a = appendRecord('verify', { type: 'run', id: undefined, ts: null, skill: 'reuse-scout', extra: 1 });
    appendRecord('../escaped', { type: 'run' });
    appendRecord('', { type: 'run' });
    console.log(JSON.stringify(a));
  `, env);
  const a = JSON.parse(r.stdout);
  assert.equal(a.skill, 'verify'); assert.equal(a.type, 'run'); assert.equal(a.extra, 1);
  assert.match(a.id, /^verify-/); assert.match(a.ts, /[+-]\d{2}:\d{2}$/);
  assert.equal(fs.existsSync(path.join(root, 'runs', '.._escaped.jsonl')), true);
  assert.equal(fs.existsSync(path.join(root, 'runs', 'unknown.jsonl')), true);
  assert.equal(fs.existsSync(path.join(root, 'escaped.jsonl')), false);
});

test('ledger: concurrent saves merge instead of clobbering; corrupt shapes are repaired', () => {
  const { root, env } = testEnv();
  const r = node(`
    import { loadLedger, saveLedger, hasRun, wasReminded } from './lib/ledger.mjs';
    saveLedger(loadLedger('c1'));
    const a = loadLedger('c1'); const b = loadLedger('c1');
    a.skills_ran.push({ skill: 'verify', prompt_id: 'p1', ts: 't1', trigger: 'model' }); saveLedger(a);
    b.reminded['reuse-scout-prompt'] = { skill: 'reuse-scout', prompt_id: 'p1', ts: 't2' }; b.repo = 'portfolio-html'; saveLedger(b);
    const m = loadLedger('c1');
    console.log(JSON.stringify([hasRun(m, 'verify'), wasReminded(m, 'reuse-scout'), m.repo, m.skills_ran.length]));
  `, env);
  assert.deepEqual(JSON.parse(r.stdout), [true, true, 'portfolio-html', 1]);
  fs.writeFileSync(path.join(root, 'state', 'bad.json'), JSON.stringify({ skills_ran: {}, reminded: [], user_invoked: 'x' }));
  const s = node(`import { loadLedger, hasRun } from './lib/ledger.mjs'; const l = loadLedger('bad'); console.log(JSON.stringify([l.session_id, Array.isArray(l.skills_ran), Array.isArray(l.user_invoked), typeof l.reminded, hasRun(l, 'verify')]));`, env);
  assert.deepEqual(JSON.parse(s.stdout), ['bad', true, true, 'object', false]);
});

test('records: excerpt collapses whitespace and cuts by code point, never mid-character', () => {
  const { env } = testEnv();
  const r = node(`
    import { excerpt } from './lib/records.mjs';
    console.log(JSON.stringify([
      excerpt('  a \\n\\n  b  ', 100),
      excerpt('a'.repeat(160) + '🚀' + 'b'.repeat(10), 161),
      excerpt(null, 10),
    ]));
  `, env);
  const [collapsed, cut, nothing] = JSON.parse(r.stdout);
  assert.equal(collapsed, 'a b');
  // The 161st code point is the whole rocket. A code-unit slice would have stopped on its high
  // surrogate and left half a character in the buffer.
  assert.equal([...cut].length, 161);
  assert.equal(cut.length, 162);
  assert.equal(cut.endsWith('🚀'), true);
  assert.equal(cut.isWellFormed(), true);
  assert.equal(nothing, '');
});

test('inferSession(null) never matches', () => {
  const { env } = testEnv();
  const r = node(`import { loadLedger, saveLedger } from './lib/ledger.mjs'; import { inferSession } from './lib/records.mjs'; saveLedger(loadLedger('fresh')); console.log(JSON.stringify([inferSession(null), inferSession(undefined)]));`, env);
  assert.deepEqual(JSON.parse(r.stdout), [null, null]);
});

test('ledger: saves are atomic and memory nulls never blank a disk value', () => {
  const { root, env } = testEnv();
  const r = node(`
    import { loadLedger, saveLedger } from './lib/ledger.mjs';
    const a = loadLedger('n1'); a.repo = 'portfolio-html'; a.cwd = '/tmp/x'; saveLedger(a);
    const b = loadLedger('n1'); b.repo = null; b.cwd = null;
    b.skills_ran.push({ skill: 'verify', prompt_id: 'p1', ts: 't1' }); saveLedger(b);
    const m = loadLedger('n1');
    console.log(JSON.stringify([m.repo, m.cwd, m.skills_ran.length]));
  `, env);
  assert.deepEqual(JSON.parse(r.stdout), ['portfolio-html', '/tmp/x', 1]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state')).filter((f) => f.includes('.tmp')), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 'n1.json'), 'utf8')).session_id, 'n1');
  // A torn file from a killed process is replaced by a whole one, never merged into nonsense.
  fs.writeFileSync(path.join(root, 'state', 'n2.json'), '{"session_id":"n2","repo":"portfo');
  node(`import { loadLedger, saveLedger } from './lib/ledger.mjs'; const l = loadLedger('n2'); l.repo = 'corp-app'; saveLedger(l);`, env);
  const healed = JSON.parse(fs.readFileSync(path.join(root, 'state', 'n2.json'), 'utf8'));
  assert.equal(healed.repo, 'corp-app');
  assert.deepEqual(fs.readdirSync(path.join(root, 'state')).filter((f) => f.includes('.tmp')), []);
});

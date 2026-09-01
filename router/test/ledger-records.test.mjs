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

// ~/claude-skills/router/test/io.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { routerDir, testEnv } from './helpers.mjs';

const node = (code, env) => spawnSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8', env, cwd: routerDir });

test('paths honor env knobs and default under HOME', () => {
  const { root, env } = testEnv();
  const r = node(`import { stateDir, runsDir, rulesPath } from './lib/paths.mjs'; console.log(JSON.stringify([stateDir(), runsDir(), rulesPath()]));`, env);
  const [s, ru, rp] = JSON.parse(r.stdout);
  assert.equal(s, path.join(root, 'state'));
  assert.equal(ru, path.join(root, 'runs'));
  assert.ok(rp.endsWith('skill-rules.json'));
  const d = node(`import { stateDir } from './lib/paths.mjs'; console.log(stateDir());`, { ...env, ROUTER_STATE_DIR: '' });
  assert.equal(d.stdout.trim(), path.join(root, '.claude', 'router-state'));
});

test('failOpen exits 0 and prints nothing when main throws', () => {
  const { env } = testEnv();
  const r = node(`import { failOpen } from './lib/io.mjs'; failOpen(() => { throw new Error('boom'); });`, env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('failOpen exits 0 after an async main resolves', () => {
  const { env } = testEnv();
  const r = node(`import { failOpen, emit } from './lib/io.mjs'; failOpen(async () => { await new Promise(r => setTimeout(r, 20)); emit({ ok: 1 }); });`, env);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { ok: 1 });
});

test('readStdin parses JSON and returns null on garbage or empty', () => {
  const { env } = testEnv();
  const good = spawnSync('node', ['--input-type=module', '-e', `import { readStdin } from './lib/io.mjs'; const v = await readStdin(); console.log(JSON.stringify(v));`], { encoding: 'utf8', env, cwd: routerDir, input: '{"a":1}' });
  assert.equal(good.stdout.trim(), '{"a":1}');
  const bad = spawnSync('node', ['--input-type=module', '-e', `import { readStdin } from './lib/io.mjs'; const v = await readStdin(); console.log(JSON.stringify(v));`], { encoding: 'utf8', env, cwd: routerDir, input: 'not json' });
  assert.equal(bad.stdout.trim(), 'null');
  const empty = spawnSync('node', ['--input-type=module', '-e', `import { readStdin } from './lib/io.mjs'; const v = await readStdin(); console.log(JSON.stringify(v));`], { encoding: 'utf8', env, cwd: routerDir, input: '' });
  assert.equal(empty.stdout.trim(), 'null');
});

test('log appends a tab line and rotates past 1 MB', () => {
  const { root, env } = testEnv();
  node(`import { log } from './lib/io.mjs'; log('prompt', 'r1', 'repo-a', 'remind', 'detail  with   spaces');`, env);
  const file = path.join(root, 'state', 'router.log');
  const line = fs.readFileSync(file, 'utf8').trim();
  const cols = line.split('\t');
  assert.equal(cols.length, 6);
  assert.deepEqual(cols.slice(1), ['prompt', 'r1', 'repo-a', 'remind', 'detail with spaces']);
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
  node(`import { log } from './lib/io.mjs'; log('prompt', 'r2', 'repo-a', 'remind');`, env);
  assert.ok(fs.existsSync(file + '.1'));
  assert.ok(fs.statSync(file).size < 1000);
});

test('parseArgs and safeJson', () => {
  const { env } = testEnv();
  const r = node(`import { parseArgs, safeJson } from './lib/args.mjs'; console.log(JSON.stringify([parseArgs(['--skill','verify','--clear','--json','{"a":1}']), safeJson('{"b":2}'), safeJson('nope'), safeJson(undefined)]));`, env);
  assert.deepEqual(JSON.parse(r.stdout), [{ skill: 'verify', clear: true, json: '{"a":1}' }, { b: 2 }, null, null]);
});

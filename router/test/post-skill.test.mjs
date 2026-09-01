// ~/claude-skills/router/test/post-skill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHook, testEnv, makeRepo, hookInput } from './helpers.mjs';

const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'x' });
const post = (over) => hookInput({ hook_event_name: 'PostToolUse', cwd: dir, tool_name: 'Skill', tool_input: { skill: 'reuse-scout', args: 'toast' }, tool_response: 'ok', ...over });
const ledgerOf = (root, sid) => JSON.parse(fs.readFileSync(path.join(root, 'state', `${sid}.json`), 'utf8'));
const runsOf = (root, skill) => { try { return fs.readFileSync(path.join(root, 'runs', `${skill}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

test('model-triggered: ledger.skills_ran + invoke record with trigger model', () => {
  const { root, env } = testEnv();
  const r = runHook('post-skill.mjs', post({ session_id: 's-m', prompt_id: 'p1' }), env);
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '');
  assert.deepEqual(ledgerOf(root, 's-m').skills_ran.map((x) => [x.skill, x.trigger]), [['reuse-scout', 'model']]);
  const recs = runsOf(root, 'reuse-scout');
  assert.equal(recs.length, 1); assert.equal(recs[0].type, 'invoke'); assert.equal(recs[0].trigger, 'model'); assert.equal(recs[0].repo, 'portfolio-html');
});

test('router-triggered: a prior reminder for the skill classifies the invoke as router', () => {
  const { root, env } = testEnv();
  runHook('on-prompt.mjs', hookInput({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's-r', prompt_id: 'p1', prompt: '토스트 컴포넌트 만들어줘' }), env);
  runHook('post-skill.mjs', post({ session_id: 's-r', prompt_id: 'p1' }), env);
  assert.equal(ledgerOf(root, 's-r').skills_ran[0].trigger, 'router');
  // The reminder now leaves its own record in the same buffer, ahead of the invoke it caused.
  assert.deepEqual(runsOf(root, 'reuse-scout').map((x) => x.type), ['remind', 'invoke']);
  assert.equal(runsOf(root, 'reuse-scout').find((x) => x.type === 'invoke').trigger, 'router');
});

test('user-triggered: same prompt_id as a typed /skill → trigger user and NO duplicate invoke line', () => {
  const { root, env } = testEnv();
  runHook('on-prompt.mjs', hookInput({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's-u', prompt_id: 'p7', prompt: '/reuse-scout toast' }), env);
  assert.equal(runsOf(root, 'reuse-scout').length, 1);
  runHook('post-skill.mjs', post({ session_id: 's-u', prompt_id: 'p7' }), env);
  assert.equal(ledgerOf(root, 's-u').skills_ran[0].trigger, 'user');
  assert.equal(runsOf(root, 'reuse-scout').length, 1);
});

test('untracked skill: ledger only, no jsonl; namespaced name is normalized', () => {
  const { root, env } = testEnv();
  runHook('post-skill.mjs', post({ session_id: 's-b', tool_input: { skill: 'superpowers:brainstorming' } }), env);
  assert.equal(ledgerOf(root, 's-b').skills_ran[0].skill, 'brainstorming');
  assert.equal(fs.existsSync(path.join(root, 'runs')), false);
});

test('other tools and malformed stdin: nothing happens', () => {
  const { root, env } = testEnv();
  runHook('post-skill.mjs', post({ session_id: 's-o', tool_name: 'Bash', tool_input: { command: 'ls' } }), env);
  assert.equal(fs.existsSync(path.join(root, 'state', 's-o.json')), false);
  assert.equal(runHook('post-skill.mjs', null, env).status, 0);
});

test('a failed Skill call is not a run: no ledger entry, no record, a skip log line', () => {
  const { root, env } = testEnv();
  runHook('post-skill.mjs', post({ session_id: 's-f', prompt_id: 'p1', tool_response: { success: false, error: 'denied' } }), env);
  assert.equal(fs.existsSync(path.join(root, 'state', 's-f.json')), false);
  assert.deepEqual(runsOf(root, 'reuse-scout'), []);
  assert.match(fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8'), /\tskill\t-\tportfolio-html\tskip\treuse-scout failed/);
});

test('missing prompt_id never produces a false user match', () => {
  const { root, env } = testEnv();
  runHook('on-prompt.mjs', hookInput({ hook_event_name: 'UserPromptSubmit', cwd: dir, session_id: 's-n', prompt_id: undefined, prompt: '/reuse-scout toast' }), env);
  runHook('post-skill.mjs', post({ session_id: 's-n', prompt_id: undefined }), env);
  assert.equal(ledgerOf(root, 's-n').skills_ran[0].trigger, 'model');
  assert.equal(runsOf(root, 'reuse-scout').length, 2);
});

test('a record write failure still leaves the ledger and a log line', () => {
  const { root, env } = testEnv();
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runs'), 'not a directory');
  const r = runHook('post-skill.mjs', post({ session_id: 's-w', prompt_id: 'p1' }), env);
  assert.equal(r.status, 0);
  assert.equal(ledgerOf(root, 's-w').skills_ran[0].skill, 'reuse-scout');
  const log = fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8');
  assert.match(log, /\tinvoke\treuse-scout model/);
  assert.match(log, /\tskill\t-\tportfolio-html\trecord-failed\treuse-scout/);
});

test('a broken rules file does not stop the ledger', () => {
  const { root, env } = testEnv();
  runHook('post-skill.mjs', post({ session_id: 's-b2', prompt_id: 'p1' }), { ...env, ROUTER_RULES: path.join(root, 'missing.json') });
  assert.equal(ledgerOf(root, 's-b2').skills_ran[0].skill, 'reuse-scout');
  assert.match(fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8'), /rules-load-failed/);
  assert.deepEqual(runsOf(root, 'reuse-scout'), []);
});

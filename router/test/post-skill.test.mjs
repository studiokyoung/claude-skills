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
  assert.equal(runsOf(root, 'reuse-scout')[0].trigger, 'router');
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

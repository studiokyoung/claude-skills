// ~/claude-skills/router/test/on-prompt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runHook, testEnv, makeRepo, hookInput } from './helpers.mjs';
import { detectUserSkill } from '../lib/prompt.mjs';

const web = makeRepo('portfolio-html', { 'web/app/page.tsx': 'x' });
const corp = makeRepo('corp-mobile', { 'app/index.tsx': 'x' });
const prompt = (over) => hookInput({ hook_event_name: 'UserPromptSubmit', ...over });
const recsOf = (root, skill) => { try { return fs.readFileSync(path.join(root, 'runs', `${skill}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };

test('detectUserSkill: raw slash, wrapped forms, unknown, plain text', () => {
  const known = ['verify', 'reuse-scout', 'save-memory', 'explain-diff'];
  assert.equal(detectUserSkill('/verify no-serve', known), 'verify');
  assert.equal(detectUserSkill('  /kyoung:reuse-scout a toast', known), 'reuse-scout');
  assert.equal(detectUserSkill('<command-name>/explain-diff</command-name><command-args>x</command-args>', known), 'explain-diff');
  assert.equal(detectUserSkill('<command-message>save-memory</command-message>', known), 'save-memory');
  assert.equal(detectUserSkill('hello <command-name>/verify</command-name> mid-sentence', known), null);
  assert.equal(detectUserSkill('/clear', known), null);
  assert.equal(detectUserSkill('please run /verify later', known), null);
  assert.equal(detectUserSkill('', known), null);
});

test('reminder fires once per session in a web repo, then goes quiet', () => {
  const { root, env } = testEnv();
  const first = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-a', prompt: '버튼 컴포넌트 하나 만들어줘' }), env);
  assert.equal(first.status, 0);
  const ctx = first.json?.hookSpecificOutput?.additionalContext || '';
  assert.equal(first.json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(ctx, /^\[skill-router\] /);
  assert.match(ctx, /reuse-scout/);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'state', 's-a.json'), 'utf8'));
  assert.equal(ledger.reminded['reuse-scout-prompt'].skill, 'reuse-scout');
  assert.equal(ledger.repo, 'portfolio-html');
  assert.match(fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8'), /\tprompt\treuse-scout-prompt\tportfolio-html\tremind\t/);
  const second = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-a', prompt: '모달 컴포넌트도 추가해줘' }), env);
  assert.equal(second.status, 0);
  assert.equal(second.stdout.trim(), '');
});

test('no match: exit 0, no output, ledger still records repo', () => {
  const { root, env } = testEnv();
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-b', prompt: 'why is this test flaky?' }), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state', 's-b.json'), 'utf8')).repo, 'portfolio-html');
});

test('save-memory reminder only in corp repos', () => {
  const { env } = testEnv();
  const k = runHook('on-prompt.mjs', prompt({ cwd: corp.dir, session_id: 's-c', prompt: '오늘은 여기까지, 정리하자' }), env);
  assert.match(k.json.hookSpecificOutput.additionalContext, /save-memory/);
  const w = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-d', prompt: '오늘은 여기까지, 정리하자' }), env);
  assert.equal(w.stdout.trim(), '');
});

test('typed /verify: no reminder, ledger.user_invoked + invoke record with trigger user', () => {
  const { root, env } = testEnv();
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-e', prompt_id: 'p9', prompt: '/verify no-serve' }), env);
  assert.equal(r.stdout.trim(), '');
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'state', 's-e.json'), 'utf8'));
  assert.deepEqual(ledger.user_invoked.map((u) => [u.skill, u.prompt_id]), [['verify', 'p9']]);
  const line = JSON.parse(fs.readFileSync(path.join(root, 'runs', 'verify.jsonl'), 'utf8').trim());
  assert.equal(line.type, 'invoke'); assert.equal(line.trigger, 'user');
  assert.equal(line.repo, 'portfolio-html'); assert.equal(line.session_id, 's-e'); assert.equal(line.prompt_id, 'p9');
});

test('unless_ran: after the user invoked reuse-scout, the prompt rule stays quiet', () => {
  const { env } = testEnv();
  runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-f', prompt: '/reuse-scout a toast' }), env);
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-f', prompt: '토스트 컴포넌트 만들어줘' }), env);
  assert.equal(r.stdout.trim(), '');
});

test('malformed stdin and wrong event: exit 0, no output', () => {
  const { env } = testEnv();
  const bad = runHook('on-prompt.mjs', null, env);
  assert.equal(bad.status, 0); assert.equal(bad.stdout.trim(), '');
  const wrong = runHook('on-prompt.mjs', hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), env);
  assert.equal(wrong.status, 0); assert.equal(wrong.stdout.trim(), '');
});

test('typed invoke skips reminder evaluation even when the body would match a rule', () => {
  const { root, env } = testEnv();
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-g', prompt_id: 'p3', prompt: '/verify 버튼 컴포넌트 하나 만들어줘' }), env);
  assert.equal(r.stdout.trim(), '');
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'state', 's-g.json'), 'utf8'));
  assert.deepEqual(Object.keys(ledger.reminded), []);
  assert.equal(ledger.user_invoked[0].skill, 'verify');
});

test('a rule without a message never emits', () => {
  const { root, env } = testEnv();
  const rules = JSON.parse(fs.readFileSync(env.ROUTER_RULES, 'utf8'));
  rules.rules.push({ id: 'no-message', skill: 'verify', event: 'prompt', repos: '*', mode: 'remind', patterns: ['zzqq-no-message-zzqq'] });
  const file = path.join(root, 'rules.json');
  fs.writeFileSync(file, JSON.stringify(rules));
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-h', prompt: 'zzqq-no-message-zzqq please' }), { ...env, ROUTER_RULES: file });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('a broken rules file logs and stays silent; a payload with no prompt and no session writes nothing', () => {
  const { root, env } = testEnv();
  const broken = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-br', prompt: '버튼 컴포넌트 하나 만들어줘' }), { ...env, ROUTER_RULES: path.join(root, 'missing.json') });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout.trim(), '');
  assert.match(fs.readFileSync(path.join(root, 'state', 'router.log'), 'utf8'), /\trules\t-\tportfolio-html\trules-load-failed\t/);
  assert.equal(fs.existsSync(path.join(root, 'state', 's-br.json')), false);
  const empty = runHook('on-prompt.mjs', { hook_event_name: 'UserPromptSubmit', cwd: web.dir }, env);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.trim(), '');
  assert.equal(fs.existsSync(path.join(root, 'state', 'unknown.json')), false);
});

test('the router never reminds on its own echoed message', () => {
  const { root, env } = testEnv();
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-echo', prompt: '[skill-router] This prompt asks to build a component. 버튼 컴포넌트 하나 만들어줘' }), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'state', 's-echo.json'), 'utf8')).reminded), []);
});

test('a firing prompt rule writes a remind record with the join keys, pattern index and an excerpt', () => {
  const { root, env } = testEnv();
  const text = `  버튼   컴포넌트   하나 만들어줘.\n${'상세한 배경 설명 '.repeat(20)}`;
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-rm', prompt_id: 'p4', prompt: text }), env);
  assert.match(r.json.hookSpecificOutput.additionalContext, /reuse-scout/);
  const recs = recsOf(root, 'reuse-scout');
  assert.equal(recs.length, 1);
  const [rec] = recs;
  assert.equal(rec.type, 'remind'); assert.equal(rec.skill, 'reuse-scout');
  assert.equal(rec.rule, 'reuse-scout-prompt'); assert.equal(rec.delivery, 'prompt');
  assert.equal(rec.repo, 'portfolio-html');
  assert.equal(rec.session_id, 's-rm'); assert.equal(rec.prompt_id, 'p4');
  assert.ok(rec.pattern_index >= 0);
  // Enough of the prompt to recognize it later, never the whole thing.
  assert.equal(rec.prompt_excerpt.length, 160);
  assert.ok(rec.prompt_excerpt.startsWith('버튼 컴포넌트 하나 만들어줘.'));
  assert.equal(/\s\s|\n/.test(rec.prompt_excerpt), false);
  assert.equal(rec.target, undefined);
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'state', 's-rm.json'), 'utf8'));
  assert.equal(ledger.reminded['reuse-scout-prompt'].prompt_id, rec.prompt_id);
});

test('no remind record when nothing fires, and a typed /skill writes only its invoke line', () => {
  const quiet = testEnv();
  runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-rm2', prompt: 'why is this test flaky?' }), quiet.env);
  assert.deepEqual(recsOf(quiet.root, 'reuse-scout'), []);
  const typed = testEnv();
  runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-rm3', prompt_id: 'p5', prompt: '/verify 버튼 컴포넌트 하나 만들어줘' }), typed.env);
  assert.deepEqual(recsOf(typed.root, 'verify').map((x) => x.type), ['invoke']);
  assert.deepEqual(recsOf(typed.root, 'reuse-scout'), []);
});

test('a harness turn is ignored even when its body matches a prompt rule', () => {
  const { root, env } = testEnv();
  const body = '<task-notification>A background task finished. Its request was: add a modal component to the settings page.</task-notification>';
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-hn', prompt_id: 'p6', prompt: body }), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(recsOf(root, 'reuse-scout'), []);
  assert.equal(fs.existsSync(path.join(root, 'state', 's-hn.json')), false);
});

test('the same sentence typed by the user still reminds', () => {
  const { root, env } = testEnv();
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-hn2', prompt_id: 'p6', prompt: 'add a modal component to the settings page.' }), env);
  assert.match(r.json.hookSpecificOutput.additionalContext, /reuse-scout/);
  assert.deepEqual(recsOf(root, 'reuse-scout').map((x) => x.type), ['remind']);
});

test('a typed skill inside a harness turn is not banked as a user invoke', () => {
  const { root, env } = testEnv();
  const body = '/verify the changes\n\n[SYSTEM NOTIFICATION - NOT USER INPUT] delivered by the harness, not typed by anyone.';
  const r = runHook('on-prompt.mjs', prompt({ cwd: web.dir, session_id: 's-hn3', prompt_id: 'p7', prompt: body }), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(recsOf(root, 'verify'), []);
  assert.equal(fs.existsSync(path.join(root, 'state', 's-hn3.json')), false);
});

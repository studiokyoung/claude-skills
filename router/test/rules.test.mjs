// ~/claude-skills/router/test/rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadRules, repoOf, inScope, rulesFor, matchPrompt, matchPromptIndex, matchPath, knownSkills } from '../lib/rules.mjs';
import { makeRepo, tmpDir } from './helpers.mjs';

delete process.env.ROUTER_RULES;
const loaded = loadRules();

test('rule table loads with compiled patterns and the top-level keys', () => {
  assert.ok(loaded.repoGroups.web.includes('portfolio-html'));
  assert.ok(loaded.docsOnly instanceof RegExp);
  assert.ok(['additionalContext', 'deny-once'].includes(loaded.preToolUseContext));
  assert.deepEqual(knownSkills(loaded).sort(), ['explain-diff', 'reuse-scout', 'save-memory', 'verify']);
  assert.deepEqual(loaded.allowSkills, ['verify', 'reuse-scout']);
  const r = loaded.rules.find((x) => x.id === 'reuse-scout-prompt');
  assert.equal(r._patterns.length, 2);
  assert.ok(r._patterns[0] instanceof RegExp);
});

test('repoOf returns the basename of the git toplevel, null outside git', () => {
  const { dir } = makeRepo('portfolio-html', { 'web/app/page.tsx': 'x' });
  assert.equal(repoOf(path.join(dir, 'web', 'app')), 'portfolio-html');
  assert.equal(repoOf(tmpDir('nogit-')), null);
  assert.equal(repoOf('/definitely/not/a/dir'), null);
});

test('scope: groups, star, explicit list, non-git', () => {
  const gate = loaded.rules.find((x) => x.id === 'verify-commit-gate');
  assert.equal(inScope(gate, 'portfolio-html', loaded.repoGroups), true);
  assert.equal(inScope(gate, 'Self-GraphDB', loaded.repoGroups), false);
  assert.equal(inScope(gate, null, loaded.repoGroups), false);
  const star = loaded.rules.find((x) => x.id === 'reuse-scout-prompt');
  assert.equal(inScope(star, null, loaded.repoGroups), true);
  assert.equal(inScope({ repos: ['corp-app'] }, 'corp-app', loaded.repoGroups), true);
  assert.equal(inScope({ repos: ['corp-app'] }, 'corp-mobile', loaded.repoGroups), false);
  assert.deepEqual(rulesFor(loaded, 'prompt', 'corp-mobile').map((r) => r.id).sort(), ['reuse-scout-prompt', 'save-memory-wrapup']);
  assert.deepEqual(rulesFor(loaded, 'prompt', 'portfolio-html').map((r) => r.id), ['reuse-scout-prompt']);
  assert.deepEqual(rulesFor(loaded, 'pre-commit', 'Self-GraphDB'), []);
});

test('prompt patterns: Korean noun-first, English verb-first, and non-matches', () => {
  const r = loaded.rules.find((x) => x.id === 'reuse-scout-prompt');
  assert.equal(matchPrompt(r, '버튼 컴포넌트 하나 만들어줘'), true);
  assert.equal(matchPrompt(r, 'Build a keyboard-avoiding footer component for the confirm screen'), true);
  assert.equal(matchPrompt(r, 'add a useDebounce hook'), true);
  assert.equal(matchPrompt(r, '결제 화면에 로딩 상태 추가해줘'), true);
  assert.equal(matchPrompt(r, 'why is this test flaky?'), false);
  assert.equal(matchPrompt(r, 'handoff 읽고 쭉 가보자'), false);
  assert.equal(matchPrompt(r, 'add a screenshot of the mobile viewport to the report'), false);
  assert.equal(matchPrompt(r, 'the build is failing on the login page, find out why'), false);
  assert.equal(matchPrompt(r, 'build 깨졌어, app/page.tsx 타입 에러 좀 봐줘'), false);
  assert.equal(matchPrompt(r, 'why does the formatter add trailing commas?'), false);
  assert.equal(matchPrompt(r, '이 화면도 추가로 확인해줘'), false);
  assert.equal(matchPrompt(r, '이 기능 추가로 테스트해봐'), false);
  assert.equal(matchPrompt(r, '컴포넌트 이름 옆에 주석 붙여줘'), false);
  assert.equal(matchPrompt(r, 'write the handoff page for todays session'), false);
  assert.equal(matchPrompt(r, 'update the shipping address validation'), false);
  const s = loaded.rules.find((x) => x.id === 'save-memory-wrapup');
  assert.equal(matchPrompt(s, '오늘은 여기까지, 정리하자'), true);
  assert.equal(matchPrompt(s, "let's wrap up"), true);
  assert.equal(matchPrompt(s, '이 함수 정리해줘'), false);
  assert.equal(matchPrompt(s, '이번 스프린트 마감일 언제야?'), false);
  assert.equal(matchPrompt(s, '이 버그만 끝내고 다음 태스크 가자'), false);
  assert.equal(matchPrompt(s, 'the middleware wraps up the handler'), false);
});

test('path patterns for the new-file backstop', () => {
  const r = loaded.rules.find((x) => x.id === 'reuse-scout-new-file');
  assert.equal(matchPath(r, 'web/components/Toast.tsx'), true);
  assert.equal(matchPath(r, 'src/hooks/useToast.ts'), true);
  assert.equal(matchPath(r, 'app/(marketing)/page.tsx'), true);
  assert.equal(matchPath(r, 'docs/notes.md'), false);
  assert.equal(matchPath(r, 'README.md'), false);
});

test('docs_only regex', () => {
  assert.equal(loaded.docsOnly.test('docs/superpowers/specs/x.md'), true);
  assert.equal(loaded.docsOnly.test('README.md'), true);
  assert.equal(loaded.docsOnly.test('web/app/page.tsx'), false);
  assert.equal(loaded.docsOnly.test('_meta/HANDOFF.md'), true);
});

test('prompt patterns: rebuild, 구현된 vs 구현돼야, 추가적', () => {
  const r = loaded.rules.find((x) => x.id === 'reuse-scout-prompt');
  assert.equal(matchPrompt(r, 'rebuild the header component'), true);
  assert.equal(matchPrompt(r, '이 기능 구현돼야 해'), true);
  assert.equal(matchPrompt(r, '이 컴포넌트 새로 구현해줘'), true);
  assert.equal(matchPrompt(r, '이 기능 이미 구현된 거 아니야?'), false);
  assert.equal(matchPrompt(r, '이 기능 구현되어 있는지 확인해줘'), false);
  assert.equal(matchPrompt(r, '추가적으로 확인해줘'), false);
  assert.equal(matchPrompt(r, '이 기능도 추가적으로 확인해줘'), false);
  assert.equal(matchPrompt(r, 'the rebuild is failing on the login page'), false);
});

test('docs_only matches by extension, never by directory name', () => {
  assert.equal(loaded.docsOnly.test('docs/spec.md'), true);
  assert.equal(loaded.docsOnly.test('README.md'), true);
  assert.equal(loaded.docsOnly.test('notes.markdown'), true);
  assert.equal(loaded.docsOnly.test('docs/x.tsx'), false);
  assert.equal(loaded.docsOnly.test('web/app/docs/page.tsx'), false);
  assert.equal(loaded.docsOnly.test('raw/session/run.mjs'), false);
});

test('matchPromptIndex names which pattern fired, -1 when none does', () => {
  const r = loaded.rules.find((x) => x.id === 'reuse-scout-prompt');
  assert.equal(matchPromptIndex(r, 'add a useDebounce hook'), 0);
  assert.equal(matchPromptIndex(r, '버튼 컴포넌트 하나 만들어줘'), 1);
  assert.equal(matchPromptIndex(r, 'why is this test flaky?'), -1);
  assert.equal(matchPrompt(r, 'add a useDebounce hook'), true);
});

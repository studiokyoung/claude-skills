// ~/claude-skills/router/test/rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRules, localRulesPath, repoOf, inScope, rulesFor, matchPrompt, matchPromptIndex, matchPath, knownSkills } from '../lib/rules.mjs';
import { FIXTURE_GROUPS, makeRepo, routerDir, shippedRules, tmpDir } from './helpers.mjs';

delete process.env.ROUTER_RULES;
const loaded = shippedRules();

// A scratch copy of the shipped table, optionally mutated, with an override beside it: the two-file
// arrangement every installed machine reads. `local` may be a string, which is how a broken one is
// written. Omit it for base-only.
function scratchRules(local, mutate) {
  const dir = tmpDir('rules-');
  const base = JSON.parse(fs.readFileSync(path.join(routerDir, 'skill-rules.json'), 'utf8'));
  if (mutate) mutate(base);
  const file = path.join(dir, 'skill-rules.json');
  fs.writeFileSync(file, JSON.stringify(base));
  if (local !== undefined) fs.writeFileSync(localRulesPath(file), typeof local === 'string' ? local : JSON.stringify(local));
  return loadRules(file);
}

test('rule table loads with compiled patterns and the top-level keys', () => {
  // The public table names no repositories: they are the one thing that has to come from the machine.
  assert.deepEqual(loaded.repoGroups, { web: [], corp: [] });
  assert.equal(loaded.localOverride, false);
  assert.ok(loaded.docsOnly instanceof RegExp);
  assert.ok(['additionalContext', 'deny-once'].includes(loaded.preToolUseContext));
  assert.deepEqual(knownSkills(loaded).sort(), ['explain-diff', 'reuse-scout', 'save-memory', 'skill-review', 'skill-router', 'verify']);
  assert.deepEqual(loaded.allowSkills, ['verify', 'reuse-scout', 'skill-router', 'skill-review']);
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
  // Scope is what the override buys, so it is judged on a merged table, never on the empty shipped one.
  const merged = scratchRules({ repo_groups: FIXTURE_GROUPS });
  const gate = merged.rules.find((x) => x.id === 'verify-commit-gate');
  assert.equal(inScope(gate, 'portfolio-html', merged.repoGroups), true);
  assert.equal(inScope(gate, 'Self-GraphDB', merged.repoGroups), false);
  assert.equal(inScope(gate, null, merged.repoGroups), false);
  // The same rule against the table as it ships: no names, so nothing is gated until a machine says so.
  assert.equal(inScope(gate, 'portfolio-html', loaded.repoGroups), false);
  const star = merged.rules.find((x) => x.id === 'reuse-scout-prompt');
  assert.equal(inScope(star, null, merged.repoGroups), true);
  assert.equal(inScope({ repos: ['corp-app'] }, 'corp-app', merged.repoGroups), true);
  assert.equal(inScope({ repos: ['corp-app'] }, 'corp-mobile', merged.repoGroups), false);
  assert.deepEqual(rulesFor(merged, 'prompt', 'corp-mobile').map((r) => r.id).sort(), ['reuse-scout-prompt', 'save-memory-wrapup']);
  assert.deepEqual(rulesFor(merged, 'prompt', 'portfolio-html').map((r) => r.id), ['reuse-scout-prompt']);
  assert.deepEqual(rulesFor(merged, 'pre-commit', 'Self-GraphDB'), []);
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

test('the probe sample rides with the rule and must still match it', () => {
  const r = loaded.rules.find((x) => x.id === 'reuse-scout-prompt');
  assert.equal(r.sample, '버튼 컴포넌트 하나 만들어줘');
  // The self-check sends this sentence through the real hook, so a pattern edit that stops matching
  // it has to fail here, in the suite, rather than at somebody's next session start.
  assert.ok(matchPromptIndex(r, r.sample) >= 0, 'the sample must match the rule it probes');
});

test('a local override replaces per key and per group, keeps the groups only the base has, and adds its own', () => {
  const merged = scratchRules(
    { repo_groups: { web: ['only-web'], extra: ['x'] }, track_skills: ['verify'] },
    (base) => { base.repo_groups = { web: ['base-web'], corp: ['base-corp'] }; },
  );
  assert.deepEqual(merged.repoGroups, { web: ['only-web'], corp: ['base-corp'], extra: ['x'] });
  assert.deepEqual(merged.trackSkills, ['verify']);
  // A key the local does not name is the base's, untouched.
  assert.deepEqual(merged.allowSkills, loaded.allowSkills);
  assert.equal(merged.localOverride, true);
  assert.deepEqual(merged.localGroups, ['web', 'extra']);
  assert.equal(merged.localError, null);
  assert.equal(merged.localPath, path.join(path.dirname(merged.localPath), 'skill-rules.local.json'));
});

test('rules merge by id: a matching id replaces in place, a new one appends, both compiled', () => {
  const merged = scratchRules({
    rules: [
      { id: 'verify-commit-gate', skill: 'verify', event: 'pre-commit', repos: 'web', mode: 'block', message: 'local gate' },
      { id: 'local-only', skill: 'verify', event: 'prompt', repos: '*', mode: 'remind', patterns: ['zzlocal-zz'], message: 'local rule' },
    ],
  });
  assert.deepEqual(merged.rules.map((r) => r.id), [...loaded.rules.map((r) => r.id), 'local-only']);
  assert.equal(merged.rules.find((r) => r.id === 'verify-commit-gate').message, 'local gate');
  // The appended rule went through the same compile step as the shipped ones, patterns and all.
  const added = merged.rules.at(-1);
  assert.ok(added._patterns[0] instanceof RegExp);
  assert.equal(matchPrompt(added, 'zzlocal-zz'), true);
});

test('no local file beside the table is base-only, and the table says so', () => {
  const only = scratchRules();
  assert.equal(only.localOverride, false);
  assert.deepEqual(only.localGroups, []);
  assert.equal(only.localError, null);
  assert.deepEqual(only.repoGroups, { web: [], corp: [] });
  assert.deepEqual(only.rules.map((r) => r.id), loaded.rules.map((r) => r.id));
});

test('a local override that does not parse falls back to base-only and names the file', () => {
  for (const [label, text] of [['torn json', '{ not json'], ['not an object', '["web"]']]) {
    const broken = scratchRules(text);
    assert.equal(broken.localOverride, false, label);
    assert.deepEqual(broken.repoGroups, { web: [], corp: [] }, label);
    assert.deepEqual(broken.rules.map((r) => r.id), loaded.rules.map((r) => r.id), label);
    assert.match(broken.localError, /skill-rules\.local\.json: /, label);
  }
});

// The override reaches the router through a symlink, so a moved target reads as ENOENT: absent, and
// every repo named only in that file would go quietly ungated. It is a broken local, and says so.
test('a local override that is a dangling symlink is broken, not absent', () => {
  const dir = tmpDir('rules-');
  const file = path.join(dir, 'skill-rules.json');
  fs.copyFileSync(path.join(routerDir, 'skill-rules.json'), file);
  fs.symlinkSync(path.join(dir, 'gone.json'), localRulesPath(file));
  const loadedLink = loadRules(file);
  assert.equal(loadedLink.localOverride, false);
  assert.match(loadedLink.localError, /skill-rules\.local\.json: broken symlink/);
});

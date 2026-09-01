// ~/claude-skills/router/test/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { routerDir } from './helpers.mjs';
import { readSkillVersion } from '../lib/records.mjs';
import { loadRules } from '../lib/rules.mjs';

const skill = (name) => fs.readFileSync(path.join(routerDir, '..', 'skills', name, 'SKILL.md'), 'utf8');
const frontmatter = (text) => text.split(/^---\s*$/m)[1] || '';
// index of a heading, asserted present — so an ordering check can never pass on a missing section
const at = (text, needle) => {
  const i = text.indexOf(needle);
  assert.ok(i > -1, `missing section: ${needle}`);
  return i;
};

test('every published skill carries metadata.version', () => {
  assert.equal(readSkillVersion('verify'), '1.1.0');
  assert.equal(readSkillVersion('reuse-scout'), '1.1.0');
  assert.equal(readSkillVersion('explain-diff'), '2.2.0');
  assert.equal(readSkillVersion('skill-router'), '1.0.0');
  assert.equal(readSkillVersion('skill-review'), '1.0.0');
});

test('verify: marker + record step present, node allowed, self-check mentions both', () => {
  const t = skill('verify');
  assert.match(frontmatter(t), /Bash\(node:\*\)/);
  assert.match(t, /references\/mark-pass\.mjs --root <projectRoot>/);
  assert.match(t, /mark-pass\.mjs --root <projectRoot> --clear/);
  assert.match(t, /references\/record-run\.mjs --skill verify/);
  // both verdicts are shown, each with a gate set that earns it (§3's rule)
  assert.match(t, /"verdict":"safe"/);
  assert.match(t, /"verdict":"not-safe"/);
  assert.ok(at(t, '## 4. Mark the tree and record the run') < at(t, '## Verification (self-check'));
  assert.match(t, /record-run\.mjs.*both run after the table/s);
});

test('reuse-scout: record step present after the self-check, node allowed', () => {
  const t = skill('reuse-scout');
  assert.match(frontmatter(t), /Bash\(node:\*\)/);
  assert.match(t, /references\/record-run\.mjs --skill reuse-scout/);
  assert.ok(at(t, '## 6. Verification') < at(t, '## 7. Record the run'));
});

test('every skill the installer pre-allows actually ships in this repo', () => {
  for (const name of loadRules().allowSkills) {
    assert.ok(fs.existsSync(path.join(routerDir, '..', 'skills', name, 'SKILL.md')), `allow_skills names ${name}, which has no SKILL.md here`);
  }
});

test('skill-review: the ritual in order, the graph conventions, and the no-edit rule', () => {
  const t = skill('skill-review');
  const fm = frontmatter(t);
  assert.match(fm, /user-invocable: true/);
  assert.match(fm, /argument-hint: "\[since <ISO>\] \[dry\]"/);
  assert.match(fm, /selfcheck\.mjs --cli/);
  assert.match(fm, /report\.mjs/);
  assert.match(fm, /Write\(\/Users\/kyounghoonkim\/Self-GraphDB\/raw\/skill-runs\/\*\*\)/);
  assert.match(fm, /Write\(\/Users\/kyounghoonkim\/Self-GraphDB\/graph\/projects\/\*\*\)/);
  assert.ok(at(t, '## 1. Is the router even on') < at(t, '## 2. Read the report'));
  assert.ok(at(t, '## 2. Read the report') < at(t, '## 3. Judgment, per skill'));
  assert.ok(at(t, '## 4. File the week into the graph') < at(t, '## 5. Mark the window'));
  assert.ok(at(t, '## 5. Mark the window') < at(t, '## 6. Misses go to debrief'));
  assert.ok(at(t, '## Boundaries') < at(t, '## Verification (self-check'));
  // the two graph conventions it must not get wrong, and the line it must never cross
  assert.match(t, /## 현재 상태 \(as-of/);
  assert.match(t, /## 강화 이력/);
  assert.match(t, /report\.mjs --mark/);
  assert.match(t, /never\s+edits a skill or the rule table on its own/);
});

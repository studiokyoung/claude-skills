// ~/claude-skills/router/test/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { routerDir } from './helpers.mjs';
import { readSkillVersion } from '../lib/records.mjs';

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

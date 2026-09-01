// ~/claude-skills/router/test/skills.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { routerDir } from './helpers.mjs';
import { readSkillVersion } from '../lib/records.mjs';

const skill = (name) => fs.readFileSync(path.join(routerDir, '..', 'skills', name, 'SKILL.md'), 'utf8');
const frontmatter = (text) => text.split(/^---\s*$/m)[1] || '';

test('every published skill carries metadata.version', () => {
  assert.equal(readSkillVersion('verify'), '1.1.0');
  assert.equal(readSkillVersion('reuse-scout'), '1.1.0');
  assert.match(readSkillVersion('explain-diff'), /^\d+\.\d+\.\d+$/);
});

test('verify: marker + record step present, node allowed, self-check mentions both', () => {
  const t = skill('verify');
  assert.match(frontmatter(t), /Bash\(node:\*\)/);
  assert.match(t, /references\/mark-pass\.mjs --root <projectRoot>/);
  assert.match(t, /mark-pass\.mjs --root <projectRoot> --clear/);
  assert.match(t, /references\/record-run\.mjs --skill verify/);
  assert.match(t, /"verdict":"safe"/);
  assert.ok(t.indexOf('## 4. Mark the tree and record the run') < t.indexOf('## Verification (self-check'));
  assert.match(t, /record-run\.mjs.*both run after the table/s);
});

test('reuse-scout: record step present after the self-check, node allowed', () => {
  const t = skill('reuse-scout');
  assert.match(frontmatter(t), /Bash\(node:\*\)/);
  assert.match(t, /references\/record-run\.mjs --skill reuse-scout/);
  assert.ok(t.indexOf('## 6. Verification') < t.indexOf('## 7. Record the run'));
});

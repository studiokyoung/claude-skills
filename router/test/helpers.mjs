// ~/claude-skills/router/test/helpers.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules } from '../lib/rules.mjs';

export const routerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tmpDir(prefix = 'router-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// The shipped table names no repositories, so a case that needs a gated repo restores coverage the
// way a real machine does: through a local override. These are the names the fixtures commit in.
export const FIXTURE_GROUPS = { web: ['portfolio-html'], corp: ['corp-app', 'corp-mobile'] };

// The shipped table exactly as it ships, read from a copy in a temp directory: a real machine keeps
// its own `skill-rules.local.json` beside the real file, and an assertion about what the repo ships
// must not see it.
export function shippedRules() {
  const file = path.join(tmpDir('shipped-rules-'), 'skill-rules.json');
  fs.copyFileSync(path.join(routerDir, 'skill-rules.json'), file);
  return loadRules(file);
}

export function testEnv(overrides = {}) {
  const root = tmpDir();
  // The table copied into this env's own root, with the scratch override beside it: every hook the
  // suite spawns therefore reads a merged table, which is what runs on an installed machine.
  const rules = path.join(root, 'skill-rules.json');
  fs.copyFileSync(path.join(routerDir, 'skill-rules.json'), rules);
  fs.writeFileSync(path.join(root, 'skill-rules.local.json'), JSON.stringify({ repo_groups: FIXTURE_GROUPS }) + '\n');
  return {
    root,
    env: {
      ...process.env,
      HOME: root,
      ROUTER_STATE_DIR: path.join(root, 'state'),
      SKILL_RUNS_DIR: path.join(root, 'runs'),
      ROUTER_RULES: rules,
      ...overrides,
    },
  };
}

export function runHook(script, stdinObj, env, args = []) {
  const r = spawnSync('node', [path.join(routerDir, script), ...args], {
    input: stdinObj == null ? '' : JSON.stringify(stdinObj),
    encoding: 'utf8',
    env,
    timeout: 20000,
  });
  let json = null;
  const last = (r.stdout || '').trim().split('\n').pop();
  try { json = last ? JSON.parse(last) : null; } catch { json = null; }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

export function makeRepo(name, files = { 'README.md': '# x\n' }) {
  const dir = path.join(tmpDir('repos-'), name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  git('init', '-q');
  git('config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, git };
}

export function hookInput(overrides = {}) {
  return {
    session_id: 'sess-test',
    prompt_id: 'p1',
    transcript_path: '/dev/null',
    cwd: process.cwd(),
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    ...overrides,
  };
}

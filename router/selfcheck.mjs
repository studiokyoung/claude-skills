#!/usr/bin/env node
// ~/claude-skills/router/selfcheck.mjs — SessionStart hook: is the router still wired, and does it
// still fire? Silent while everything passes; one context line naming what broke when it does not.
//   node selfcheck.mjs --cli   → the same checks as a PASS/FAIL table, exit 1 on any failure
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failOpen, readStdin, emit, log } from './lib/io.mjs';
import { HOOK_ENTRIES } from './lib/entries.mjs';
import { routerDir, rulesPath, settingsPath } from './lib/paths.mjs';
import { loadRules } from './lib/rules.mjs';
import { appendRecord } from './lib/records.mjs';

// The session starts worth re-checking: a real new session, or one being resumed into.
const SOURCES = ['startup', 'resume'];

const pass = (name, detail) => ({ name, ok: true, detail });
const fail = (name, detail) => ({ name, ok: false, detail });
// An informational check still lands in the record, so the number is there when somebody looks, but
// it never flips the verdict: nothing about the router is broken because the node version is old.
const note = (name, detail) => ({ name, ok: false, detail, informational: true });
const blocking = (checks) => checks.filter((c) => !c.ok && !c.informational);

// ---------------------------------------------------------------- static checks

function checkSettings(loaded) {
  const p = settingsPath();
  let s;
  try { s = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fail('settings', `${p}: ${e.code === 'ENOENT' ? 'not found' : e.message}`); }
  const R = routerDir();
  const problems = [];
  for (const { event, script } of HOOK_ENTRIES) {
    const list = Array.isArray(s.hooks && s.hooks[event]) ? s.hooks[event] : [];
    const ours = list.flatMap((e) => ((e && e.hooks) || []).map((h) => String((h && h.command) || ''))).filter((c) => c.endsWith(`/router/${script}`));
    if (ours.length === 0) problems.push(`${event}: ${script} not registered`);
    // Registered from a checkout that is not this one: the scripts that run are not the ones checked here.
    else if (!ours.includes(`node ${R}/${script}`)) problems.push(`${event}: ${script} runs from ${path.dirname(ours[0].replace(/^node\s+/, ''))}`);
  }
  const allow = Array.isArray(s.permissions && s.permissions.allow) ? s.permissions.allow : [];
  // Skipped when the rule table did not load: the rules check already says so, and a check must not
  // fail for a reason it could not evaluate.
  if (loaded) {
    const missing = loaded.allowSkills.map((x) => `Skill(${x})`).filter((x) => !allow.includes(x));
    if (missing.length) problems.push(`permissions.allow missing ${missing.join(' ')}`);
  }
  if (!(s.env && s.env.SKILL_RUNS_DIR)) problems.push('env.SKILL_RUNS_DIR unset');
  return problems.length ? fail('settings', problems.join('; ')) : pass('settings', `${HOOK_ENTRIES.length} hooks, ${allow.length} allow rules, SKILL_RUNS_DIR set`);
}

function checkRules() {
  let loaded;
  let raw;
  try {
    loaded = loadRules();
    raw = JSON.parse(fs.readFileSync(rulesPath(), 'utf8'));
  } catch (e) {
    return { result: fail('rules', `${rulesPath()}: ${e.message}`), loaded: null };
  }
  const problems = [];
  for (const r of loaded.rules) {
    if ((r.event === 'prompt' || r.event === 'new-file') && !String(r.message || '').trim()) problems.push(`${r.id}: no message, so it can never fire`);
    // It would still deny, but with no skill there is no buffer to write the gate record into, and
    // pre-tool.mjs can only log that it skipped one: the decisions would vanish from the loop.
    if (r.event === 'pre-commit' && r.mode === 'block' && !String(r.skill || '').trim()) problems.push(`${r.id}: a blocking gate rule with no skill, so its decisions are recorded nowhere`);
    const scope = r.repos ?? '*';
    if (typeof scope === 'string' && scope !== '*' && !(scope in loaded.repoGroups)) problems.push(`${r.id}: repo group "${scope}" is not in repo_groups`);
  }
  if (!['additionalContext', 'deny-once'].includes(raw.pretooluse_context)) problems.push(`pretooluse_context "${raw.pretooluse_context}" is neither additionalContext nor deny-once`);
  const result = problems.length
    ? fail('rules', problems.join('; '))
    : pass('rules', `${loaded.rules.length} rules, ${Object.keys(loaded.repoGroups).length} groups, ${loaded.preToolUseContext}`);
  return { result, loaded };
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 22 ? pass('node', process.version) : note('node', `${process.version} is below the v22 the router is written for`);
}

// ---------------------------------------------------------------- probes

// Every probe runs the real scripts against throwaway directories, with SKILL_ROUTER_PROBE set so a
// probe run can never write a real record (and can never re-enter this check).
function probeEnv(root) {
  return {
    ...process.env,
    HOME: root,
    ROUTER_STATE_DIR: path.join(root, 'state'),
    SKILL_RUNS_DIR: path.join(root, 'runs'),
    ROUTER_RULES: rulesPath(),
    SKILL_ROUTER_PROBE: '1',
  };
}

// One spawn per probe, all of them in flight at once: four node starts in sequence is most of a
// SessionStart budget, and they have no reason to wait for each other (separate sessions, separate
// payloads). Never rejects — a probe that could not start is a failed check, not a thrown hook.
function spawnHook(script, payload, env) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(process.execPath, [path.join(routerDir(), script)], { env, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { resolve({ status: null, out: {}, error: e.message }); return; }
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, out: {}, error: e.message }); });
    child.on('close', (status) => {
      clearTimeout(timer);
      const last = stdout.trim().split('\n').pop();
      let json = null;
      try { json = last ? JSON.parse(last) : null; } catch {}
      resolve({ status, out: (json && json.hookSpecificOutput) || {} });
    });
    try { child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(payload)); } catch {}
  });
}

// The prompt a probe sends is the rule's own `sample`, so the sentence that must match lives in the
// rule table beside the patterns it exercises, never hand-written here.
const sampleRule = (loaded) => loaded.rules.find((r) => r.event === 'prompt' && (r.repos ?? '*') === '*' && String(r.sample || '').trim());

function gateRepoName(loaded) {
  const rule = loaded.rules.find((r) => r.event === 'pre-commit' && r.mode === 'block');
  if (!rule) return null;
  const scope = rule.repos ?? '*';
  const list = Array.isArray(scope) ? scope : (loaded.repoGroups[scope] || []);
  return list[0] || null;
}

// A throwaway checkout named after a gated repo, with one staged .tsx so the commit the gate sees
// carries a candidate that is not documentation.
function stageGateRepo(root, name) {
  const repo = path.join(root, 'repos', name);
  try {
    fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
    // Two git calls plus the 5 s probe kill has to stay clear of the hook's 10 s timeout, and neither
    // of these ever takes more than a few tens of milliseconds on a repo this size.
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', timeout: 1500, stdio: 'ignore' });
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'app', 'probe.tsx'), 'export const probe = 1;\n');
    git('add', 'app/probe.tsx');
    return repo;
  } catch { return null; }
}

async function runProbes(loaded, env, root) {
  const rule = sampleRule(loaded);
  const gate = gateRepoName(loaded);
  const tracked = loaded.trackSkills[0];
  const repo = gate ? stageGateRepo(root, gate) : null;
  const [prompt, write, commit, skill] = await Promise.all([
    rule && spawnHook('on-prompt.mjs', {
      hook_event_name: 'UserPromptSubmit', session_id: 'selfcheck-prompt', prompt_id: 'selfcheck', cwd: root, prompt: rule.sample,
    }, env),
    repo && spawnHook('pre-tool.mjs', {
      hook_event_name: 'PreToolUse', session_id: 'selfcheck-write', cwd: repo,
      tool_name: 'Write', tool_input: { file_path: path.join(repo, 'components', 'SelfCheck.tsx') },
    }, env),
    repo && spawnHook('pre-tool.mjs', {
      hook_event_name: 'PreToolUse', session_id: 'selfcheck-commit', cwd: repo,
      tool_name: 'Bash', tool_input: { command: 'git commit -m x' },
    }, env),
    tracked && spawnHook('post-skill.mjs', {
      hook_event_name: 'PostToolUse', session_id: 'selfcheck-skill', prompt_id: 'selfcheck', cwd: root,
      tool_name: 'Skill', tool_input: { skill: tracked, args: '' }, tool_response: { success: true },
    }, env),
  ]);

  const out = [];
  if (!rule) out.push(fail('probe.on-prompt', 'no *-scoped prompt rule carries a "sample" to probe with'));
  else {
    const ctx = String(prompt.out.additionalContext || '');
    out.push(prompt.status === 0 && ctx.includes('[skill-router]')
      ? pass('probe.on-prompt', `${rule.id} reminded`)
      : fail('probe.on-prompt', `${rule.id} did not remind on its own sample (exit ${prompt.status}, ${ctx ? 'context without the tag' : 'no context'})`));
  }

  if (!gate) out.push(fail('probe.pre-tool', 'no pre-commit block rule in the table'));
  else if (!repo) out.push(fail('probe.pre-tool', `could not build a throwaway ${gate} checkout to probe with`));
  else {
    const asContext = loaded.preToolUseContext === 'additionalContext';
    const delivered = asContext
      ? String(write.out.additionalContext || '').includes('[skill-router]')
      : write.out.permissionDecision === 'deny' && String(write.out.permissionDecisionReason || '').includes('[skill-router]');
    if (write.status !== 0 || !delivered) out.push(fail('probe.pre-tool', `new-file reminder not delivered as ${loaded.preToolUseContext} (exit ${write.status})`));
    else if (commit.status !== 0 || commit.out.permissionDecision !== 'deny') out.push(fail('probe.pre-tool', `an unverified commit in ${gate} was not denied (exit ${commit.status}, decision ${commit.out.permissionDecision || 'none'})`));
    else out.push(pass('probe.pre-tool', `new-file reminder + commit deny in ${gate}`));
  }

  if (!tracked) out.push(fail('probe.post-skill', 'track_skills is empty, so no invocation would be recorded'));
  else {
    const ledger = path.join(root, 'state', 'selfcheck-skill.json');
    out.push(skill.status === 0 && fs.existsSync(ledger)
      ? pass('probe.post-skill', `${tracked} invocation ledgered`)
      : fail('probe.post-skill', `a ${tracked} invocation left no session ledger (exit ${skill.status})`));
  }
  return out;
}

// ---------------------------------------------------------------- driver

async function runChecks() {
  const t0 = Date.now();
  const { result: rules, loaded } = checkRules();
  const checks = [checkSettings(loaded), rules];
  let root = null;
  try {
    if (!loaded) {
      for (const n of ['probe.on-prompt', 'probe.pre-tool', 'probe.post-skill']) checks.push(fail(n, 'skipped: the rule table did not load'));
    } else {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'router-selfcheck-')));
      checks.push(...await runProbes(loaded, probeEnv(root), root));
    }
  } finally {
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
  }
  checks.push(checkNode());
  return { checks, ms: Date.now() - t0 };
}

function record(checks, ms) {
  const failures = blocking(checks);
  const rec = {
    type: 'health',
    ok: failures.length === 0,
    checks: Object.fromEntries(checks.map((c) => [c.name, c.ok])),
    ms,
    node: process.version,
    router_dir: routerDir(),
  };
  // Every check that did not pass is written down, informational ones included; only the blocking
  // ones set `ok` and reach the session.
  const notPassing = checks.filter((c) => !c.ok);
  if (notPassing.length) rec.failures = notPassing.map((c) => ({ check: c.name, reason: c.detail, informational: Boolean(c.informational) }));
  try { appendRecord('router', rec); } catch {}
  if (failures.length) log('health', '-', '-', 'fail', failures.map((c) => c.name).join(' '));
  else log('health', '-', '-', 'ok', `${checks.length} checks ${ms}ms`);
  return failures;
}

async function cli() {
  const { checks, ms } = await runChecks();
  const failures = blocking(checks);
  const notes = checks.filter((c) => !c.ok && c.informational);
  const pad = Math.max(...checks.map((c) => c.name.length));
  const lines = [`router self-check · ${routerDir()} · ${process.version}`];
  for (const c of checks) lines.push(`${c.ok ? '✅' : c.informational ? '⚠️' : '❌'} ${c.name.padEnd(pad)}  ${c.detail}`);
  const tail = notes.length ? ` · ${notes.length} note${notes.length === 1 ? '' : 's'}` : '';
  lines.push(failures.length ? `FAIL · ${failures.length} of ${checks.length} checks failed · ${ms}ms${tail} · repair with /skill-router install` : `PASS · ${checks.length} checks · ${ms}ms${tail}`);
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(failures.length ? 1 : 0);
}

if (process.argv.slice(2).includes('--cli')) {
  cli().catch((e) => { process.stdout.write(`FAIL · self-check could not run: ${e && e.message}\n`); process.exit(1); });
} else {
  failOpen(async () => {
    // A probe run must never probe itself, and a session that switched the check off gets nothing at all.
    if (process.env.SKILL_ROUTER_SELFCHECK === '0' || process.env.SKILL_ROUTER_PROBE === '1') return;
    const input = await readStdin();
    if (input && input.hook_event_name && input.hook_event_name !== 'SessionStart') return;
    // A /clear or a compaction fires SessionStart again inside a session whose install cannot have
    // changed since the last check, and the probes cost four spawns. A payload carrying no `source`
    // at all still runs, so a bare invocation is never silently skipped.
    if (input && input.source !== undefined && !SOURCES.includes(input.source)) return;
    const { checks, ms } = await runChecks();
    const failures = record(checks, ms);
    if (!failures.length) return;
    const why = failures.map((c) => `${c.name} (${c.detail})`).join('; ');
    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[skill-router] self-check FAILED: ${why}. Run /skill-router status; repair with /skill-router install.` } });
  });
}

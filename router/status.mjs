#!/usr/bin/env node
// ~/claude-skills/router/status.mjs — what /skill-router reports, read from disk in this run.
//   node status.mjs [--json|--md] [--cwd <dir>] [--log <n>]
// It NEVER writes: no ledger, no record, no log line, not even a directory. Every field is a read.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { HOOK_ENTRIES } from './lib/entries.mjs';
import { routerDir, rulesPath, runsDir, settingsPath, stateDir } from './lib/paths.mjs';
import { loadRules, repoOf, rulesFor } from './lib/rules.mjs';
import { repoRoot, markerPath, readMarker } from './lib/git.mjs';
import { ageSeconds } from './lib/records.mjs';

const USAGE = 'router: usage: node status.mjs [--json|--md] [--cwd <dir>] [--log <n>]';
const argv = process.argv.slice(2);
const VALID = new Set(['json', 'md', 'cwd', 'log']);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].startsWith('--') ? argv[i].slice(2) : null;
  if (key === null || !VALID.has(key)) { console.error(USAGE); process.exit(2); }
  if (key === 'cwd' || key === 'log') i++; // their value is the next token
}
const a = parseArgs(argv);
const tail = Number.isFinite(Number(a.log)) && Number(a.log) > 0 ? Math.floor(Number(a.log)) : 8;
const cwd = path.resolve(typeof a.cwd === 'string' ? a.cwd : process.cwd());

// ---------------------------------------------------------------- settings

function settingsView(allowSkills) {
  const p = settingsPath();
  const view = { path: p, ok: false, error: null, hooks: [], allow: { expected: [], other_skill_allows: 0 }, skill_runs_dir: null };
  let s;
  try { s = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { view.error = e.code === 'ENOENT' ? `not found: ${p}` : `does not parse as JSON: ${e.message}`; return view; }
  view.ok = true;
  const R = routerDir();
  for (const { event, script } of HOOK_ENTRIES) {
    const list = Array.isArray(s.hooks && s.hooks[event]) ? s.hooks[event] : [];
    const ours = list.flatMap((e) => ((e && e.hooks) || []).map((h) => String((h && h.command) || ''))).filter((c) => c.endsWith(`/router/${script}`));
    const dir = ours.length ? path.dirname(ours[0].replace(/^node\s+/, '')) : null;
    view.hooks.push({ event, script, found: ours.length > 0, dir, this_router: dir === R });
  }
  const allow = Array.isArray(s.permissions && s.permissions.allow) ? s.permissions.allow : [];
  const expected = allowSkills.map((x) => `Skill(${x})`);
  view.allow.expected = expected.map((rule) => ({ rule, present: allow.includes(rule) }));
  view.allow.other_skill_allows = allow.filter((x) => /^Skill\(/.test(x) && !expected.includes(x)).length;
  view.skill_runs_dir = (s.env && s.env.SKILL_RUNS_DIR) || null;
  return view;
}

// ---------------------------------------------------------------- rules, repo, log, records

function rulesView() {
  const view = { path: rulesPath(), ok: false, error: null, repo_groups: {}, rules: [], pretooluse_context: null };
  let loaded;
  try { loaded = loadRules(); }
  catch (e) { view.error = e.message; return { view, loaded: null }; }
  view.ok = true;
  view.repo_groups = loaded.repoGroups;
  view.pretooluse_context = loaded.preToolUseContext;
  view.rules = loaded.rules.map((r) => ({ id: r.id, skill: r.skill, event: r.event, repos: r.repos ?? '*', mode: r.mode }));
  return { view, loaded };
}

function repoView(loaded) {
  // Identity comes from the common git dir, so a linked worktree answers with its main checkout's
  // name and stays in its group; the marker stays per worktree, which is where the gate looks.
  const root = repoRoot(cwd);
  const name = root ? repoOf(cwd) : null;
  const rule = loaded ? rulesFor(loaded, 'pre-commit', name).find((r) => r.mode === 'block') : null;
  const marker = { path: root ? markerPath(cwd) : null, present: false, ts: null, age_s: null };
  if (marker.path) {
    const m = readMarker(cwd);
    if (m) { marker.present = true; marker.ts = m.ts || null; marker.age_s = ageSeconds(m.ts); }
  }
  return { cwd, root, name, gated: Boolean(rule), rule: rule ? rule.id : null, marker };
}

// Rotation means a decision from an hour ago can be one file over; the tail spans both, in order.
function logView() {
  const file = path.join(stateDir(), 'router.log');
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.length); } catch { return null; } };
  const rotated = read(`${file}.1`);
  const current = read(file);
  const lines = [...(rotated || []), ...(current || [])];
  return { path: file, present: current !== null, rotated: rotated !== null, lines: lines.slice(-tail) };
}

function recordsView() {
  const dir = runsDir();
  const view = { dir, present: false, files: [] };
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); }
  catch { return view; }
  view.present = true;
  for (const file of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter((l) => l.trim());
    const types = {};
    for (const l of lines) {
      let t;
      try { t = (JSON.parse(l) || {}).type || 'run'; } catch { t = 'unparsed'; }
      types[t] = (types[t] || 0) + 1;
    }
    view.files.push({ file, lines: lines.length, types });
  }
  return view;
}

// The newest health line the SessionStart check left, which is the last time anything proved the
// router still fires. Null when the check has never run here.
function healthView() {
  let text;
  try { text = fs.readFileSync(path.join(runsDir(), 'router.jsonl'), 'utf8'); } catch { return null; }
  let last = null;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if (r && r.type === 'health') last = r; } catch {}
  }
  if (!last) return null;
  return { ts: last.ts || null, ok: Boolean(last.ok), checks: last.checks || {}, ms: last.ms ?? null, failures: last.failures || [] };
}

const { view: rules, loaded } = rulesView();
const out = {
  router_dir: routerDir(),
  settings: settingsView(loaded ? loaded.allowSkills : []),
  rules,
  repo: repoView(loaded),
  log: logView(),
  records: recordsView(),
  health: healthView(),
  // Whether the running session predates the current settings file cannot be known from here, so the
  // caveat is unconditional rather than guessed at.
  caveats: ['hooks are captured at session start: a session opened before the install does not run them until it is restarted'],
};

// ---------------------------------------------------------------- render

function md(o) {
  const L = [`router status · ${o.router_dir}`];
  L.push(`settings  ${o.settings.path}`);
  if (!o.settings.ok) L.push(`  ${o.settings.error}`);
  for (const h of o.settings.hooks) {
    if (!h.found) L.push(`  MISSING ${h.event} ${h.script}`);
    else L.push(`  ok      ${h.event} ${h.script}${h.this_router ? ' (this router)' : ` (ANOTHER checkout: ${h.dir})`}`);
  }
  if (o.settings.ok) {
    L.push(`  allow   ${o.settings.allow.expected.map((x) => `${x.rule} ${x.present ? 'ok' : 'MISSING'}`).join(' · ') || '(none expected)'} · ${o.settings.allow.other_skill_allows} other Skill(...) allows`);
    L.push(`  records SKILL_RUNS_DIR=${o.settings.skill_runs_dir || '(unset)'}`);
  }
  L.push(`rules     ${o.rules.path}`);
  if (!o.rules.ok) L.push(`  does not load: ${o.rules.error}`);
  else {
    L.push(`  ${o.rules.rules.length} rules · pretooluse_context ${o.rules.pretooluse_context}`);
    for (const [g, list] of Object.entries(o.rules.repo_groups)) L.push(`  ${g}: ${list.join(', ')}`);
    for (const r of o.rules.rules) L.push(`  ${r.id} · ${r.event} · ${Array.isArray(r.repos) ? r.repos.join('/') : r.repos} · ${r.mode} → ${r.skill}`);
  }
  const rp = o.repo;
  L.push(`repo      ${rp.name || '(not a git repository)'}${rp.root ? ` (${rp.root})` : ''} · ${rp.gated ? `GATED by ${rp.rule}` : 'not gated'}`);
  if (rp.marker.path) L.push(`  marker  ${rp.marker.path}${rp.marker.present ? ` · ts ${rp.marker.ts} · ${rp.marker.age_s}s old` : ' · absent'}`);
  L.push(`log       ${o.log.present ? `last ${o.log.lines.length} of ${o.log.path}${o.log.rotated ? ' (+ router.log.1)' : ''}` : `no log yet at ${o.log.path}`}`);
  for (const l of o.log.lines) L.push(`  ${l}`);
  L.push(`records   ${o.records.present ? o.records.dir : `no records yet at ${o.records.dir}`}`);
  for (const f of o.records.files) L.push(`  ${f.file} · ${f.lines} lines · ${Object.entries(f.types).map(([t, n]) => `${t} ${n}`).join(' · ')}`);
  L.push(`health    ${o.health ? `${o.health.ts} · ${o.health.ok ? 'ok' : 'FAILED'} · ${Object.keys(o.health.checks).length} checks · ${o.health.ms}ms` : 'no self-check has run yet'}`);
  if (o.health) for (const f of o.health.failures) L.push(`  ${f.informational ? '⚠️ ' : ''}${f.check}: ${f.reason}`);
  L.push('caveats');
  for (const c of o.caveats) L.push(`  - ${c}`);
  return L.join('\n');
}

process.stdout.write(a.json === true ? JSON.stringify(out, null, 2) + '\n' : md(out) + '\n');

#!/usr/bin/env node
// ~/claude-skills/router/install.mjs — register the router in a Claude Code settings file (idempotent).
//   node install.mjs                      → ~/.claude/settings.json
//   node install.mjs --settings <path>    → another settings file
//   node install.mjs --dry-run | --uninstall
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from './lib/args.mjs';
import { routerDir } from './lib/paths.mjs';
import { HOOK_ENTRIES } from './lib/entries.mjs';
import { loadRules } from './lib/rules.mjs';

const argv = process.argv.slice(2);
if (argv.some((t) => /^--settings=/.test(t))) { console.error('router: use --settings <path> (a space, not =)'); process.exit(2); }
// A typo (`--setting`) or a stray positional must not read as "install with the defaults" and
// rewrite the real settings file.
const VALID = new Set(['settings', 'dry-run', 'uninstall']);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].startsWith('--') ? argv[i].slice(2) : null;
  if (key === null || !VALID.has(key)) {
    console.error('router: usage: node install.mjs [--settings <path>] [--dry-run] [--uninstall]');
    process.exit(2);
  }
  if (key === 'settings') i++; // its value is the next token, not a positional
}
const a = parseArgs(argv);
if (a.settings === true) { console.error('router: --settings needs a path'); process.exit(2); }
const settingsPath = path.resolve(typeof a.settings === 'string' ? a.settings : path.join(os.homedir(), '.claude', 'settings.json'));
const R = routerDir();
const ALLOW = loadRules().allowSkills.map((s) => `Skill(${s})`);
const ENV = { SKILL_RUNS_DIR: path.join(os.homedir(), '.claude', 'skill-runs') };
const uninstall = a.uninstall === true;

let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) { console.error(`router: cannot parse ${settingsPath}: ${e.message}`); process.exit(1); }
}
const changes = [];
const isOurs = (h) => h && typeof h.command === 'string' && h.command.startsWith(`node ${R}/`);

settings.hooks ||= {};
for (const { event, matcher, script, timeout } of HOOK_ENTRIES) {
  const list = settings.hooks[event] || [];
  if (uninstall) {
    const kept = [];
    for (const entry of list) {
      const hooks = entry.hooks || [];
      const survivors = hooks.filter((h) => !isOurs(h));
      for (const h of hooks) if (isOurs(h)) changes.push(`hooks.${event}: removed ${path.basename(h.command)}`);
      if (survivors.length === hooks.length) kept.push(entry);
      else if (survivors.length) kept.push({ ...entry, hooks: survivors });
    }
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
    continue;
  }
  const present = list.some((entry) => (entry.hooks || []).some((h) => isOurs(h) && h.command.endsWith(`/${script}`)));
  if (present) continue;
  // The same script registered from a checkout that has since moved: repoint it instead of adding
  // a second entry, so the settings file cannot end up running two copies of the router.
  const stale = new RegExp(`^node .*/router/${script.replace(/\./g, '\\.')}$`);
  let replaced = false;
  for (const e of list) {
    for (const h of e.hooks || []) {
      if (typeof h.command === 'string' && stale.test(h.command)) { h.command = `node ${R}/${script}`; replaced = true; }
    }
  }
  if (replaced) { settings.hooks[event] = list; changes.push(`hooks.${event}: replaced ${script}`); continue; }
  const entry = {};
  if (matcher) entry.matcher = matcher;
  entry.hooks = [{ type: 'command', command: `node ${R}/${script}`, timeout }];
  settings.hooks[event] = [...list, entry];
  changes.push(`hooks.${event}: added ${script}`);
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

settings.permissions ||= {};
settings.permissions.allow ||= [];
for (const rule of ALLOW) {
  const has = settings.permissions.allow.includes(rule);
  if (uninstall && has) { settings.permissions.allow = settings.permissions.allow.filter((x) => x !== rule); changes.push(`permissions.allow: removed ${rule}`); }
  if (!uninstall && !has) { settings.permissions.allow.push(rule); changes.push(`permissions.allow: added ${rule}`); }
}

settings.env ||= {};
for (const [k, v] of Object.entries(ENV)) {
  if (uninstall && k in settings.env) {
    if (settings.env[k] === v) { delete settings.env[k]; changes.push(`env: removed ${k}`); }
    else console.log(`router: env: kept ${k} (user value)`);
  }
  if (!uninstall && !(k in settings.env)) { settings.env[k] = v; changes.push(`env: set ${k}=${v}`); }
}
if (Object.keys(settings.env).length === 0) delete settings.env;

if (changes.length === 0) { console.log('router: nothing to change'); process.exit(0); }
if (a['dry-run'] === true) { console.log(`router (dry-run) would change ${settingsPath}:\n  ${changes.join('\n  ')}`); process.exit(0); }
if (fs.existsSync(settingsPath)) {
  const bak = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(settingsPath, bak);
  console.log(`router: backup ${bak}`);
}
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`router: updated ${settingsPath}\n  ${changes.join('\n  ')}`);

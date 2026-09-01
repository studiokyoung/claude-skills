// ~/claude-skills/router/lib/report.mjs — the weekly review's arithmetic. Deterministic: every
// number here comes from a record line, so the judgment in /skill-review argues with evidence.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';
import { inScope } from './rules.mjs';

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// The gate writes the marker's own timestamp into its reason (`verified 2026-09-01T00:12:03.227-04:00`,
// `tree changed since ...`), so bucketing on the raw string is a bucket per commit and the whole
// column reads as noise. Strip a trailing ISO timestamp and the vocabulary collapses back to the
// handful of reasons the gate actually has; every other reason is already a constant and passes through.
const TRAILING_TS = /\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
export const normalizeWhy = (why) => String(why ?? '').trim().replace(TRAILING_TS, '') || 'unknown';

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const watermarkPath = () => path.join(stateDir(), 'review-watermark.json');

export function readWatermark() {
  try { return JSON.parse(fs.readFileSync(watermarkPath(), 'utf8')); } catch { return null; }
}

export function writeWatermark(iso) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(watermarkPath(), JSON.stringify({ last: iso }, null, 2) + '\n');
}

// Every buffer, oldest line first. A line that does not parse is skipped rather than fatal: the
// buffers are appended to by hooks that must never block, so a torn last line is a real possibility.
export function readRecords(dir, sinceMs) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const f of files.sort()) {
    let text;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const t = Date.parse(r.ts);
      if (Number.isNaN(t) || t < sinceMs) continue;
      r._t = t;
      out.push(r);
    }
  }
  return out.sort((a, b) => a._t - b._t);
}

function emptySkill() {
  return {
    invoke: { total: 0, user: 0, router: 0, model: 0 },
    remind: { total: 0, converted: 0, rate: 0, rules: {} },
    run: { total: 0, verdicts: {}, versions: {}, gates: {}, outcome_sums: {}, caught: [], caught_total: 0 },
    gate: { total: 0, allow: {}, deny: {}, cycles: { count: 0, median_marker_age_s: null, median_denies_before_first_allow: null }, overrides: { count: 0, commands: [] } },
    annotation: { missed: [], caught: [] },
  };
}

const TRIGGERS = ['user', 'router', 'model'];
const CAUGHT_CAP = 20;
const EXCERPT_CAP = 10;

export function aggregate(records, window) {
  const skills = {};
  const S = (name) => (skills[name] ||= emptySkill());
  const totals = { records: records.length, invoke: 0, remind: 0, run: 0, gate: 0, annotation: 0, health: 0 };
  const health = { ok: 0, fail: 0, notes: {}, last_failures: [], last_fail_ts: null };
  const reminders = [];
  const gateLines = [];
  // key: skill + session, value: when that skill actually ran there. What a reminder converts into.
  const ran = new Map();
  const push = (map, key, value) => { const cur = map.get(key); if (cur) cur.push(value); else map.set(key, [value]); };

  for (const r of records) {
    const type = r.type || 'run';
    if (type === 'health') {
      totals.health++;
      const entries = list(r.failures).filter((f) => f && typeof f === 'object');
      // An informational check rides along on a record that is `ok` (an old node version breaks
      // nothing), so the notes are counted off every record, passing or not. Counting them as
      // failures would cry wolf; dropping them is how a note nobody ever sees stays unfixed.
      for (const f of entries) if (f.informational) bump(health.notes, f.check || 'unknown');
      if (r.ok) health.ok++;
      else { health.fail++; health.last_failures = entries.filter((f) => !f.informational); health.last_fail_ts = r.ts; }
      continue;
    }
    const name = r.skill;
    if (!name) continue;
    const s = S(name);
    if (type === 'invoke') {
      totals.invoke++;
      s.invoke.total++;
      if (TRIGGERS.includes(r.trigger)) s.invoke[r.trigger]++;
    } else if (type === 'remind') {
      totals.remind++;
      s.remind.total++;
      const rule = (s.remind.rules[r.rule || 'unknown'] ||= { total: 0, converted: 0, unconverted: [] });
      rule.total++;
      reminders.push({ rec: r, skill: name, rule });
    } else if (type === 'gate') {
      totals.gate++;
      s.gate.total++;
      const why = normalizeWhy(r.why);
      bump(r.decision === 'deny' ? s.gate.deny : s.gate.allow, why);
      if (why === 'override SKIP_VERIFY') {
        s.gate.overrides.count++;
        if (s.gate.overrides.commands.length < EXCERPT_CAP) s.gate.overrides.commands.push(r.command_excerpt || '');
      }
      gateLines.push({ rec: r, skill: name });
    } else if (type === 'annotation') {
      totals.annotation++;
      const add = (into, v) => { for (const t of list(v)) if (String(t ?? '').trim()) into.push({ ref: r.ref || null, text: String(t), by: r.by || null }); };
      add(s.annotation.missed, r.missed);
      add(s.annotation.caught, r.caught);
    } else {
      totals.run++;
      s.run.total++;
      const o = r.outcome && typeof r.outcome === 'object' && !Array.isArray(r.outcome) ? r.outcome : {};
      const verdict = typeof o.verdict === 'string' ? o.verdict : 'unrecorded';
      bump(s.run.verdicts, verdict);
      const v = (s.run.versions[r.version || 'unversioned'] ||= { total: 0, verdicts: {} });
      v.total++;
      bump(v.verdicts, verdict);
      if (o.gates && typeof o.gates === 'object') for (const [g, st] of Object.entries(o.gates)) if (typeof st === 'string') bump((s.run.gates[g] ||= {}), st);
      for (const [k, n] of Object.entries(o)) if (typeof n === 'number' && Number.isFinite(n)) bump(s.run.outcome_sums, k, n);
      const caught = list(r.caught);
      s.run.caught_total += caught.length;
      for (const c of caught) if (s.run.caught.length < CAUGHT_CAP) s.run.caught.push(typeof c === 'string' ? c : JSON.stringify(c));
    }
    if ((type === 'invoke' || type === 'run') && r.session_id) push(ran, `${name} ${r.session_id}`, r._t);
  }

  // A reminder converted when the skill it asked for ran later in the SAME session, however it was
  // triggered. The reminders with nothing after them are the pattern-quality material.
  for (const { rec, skill, rule } of reminders) {
    const after = ran.get(`${skill} ${rec.session_id}`) || [];
    const converted = Boolean(rec.session_id) && after.some((t) => t >= rec._t);
    if (converted) { skills[skill].remind.converted++; rule.converted++; }
    else rule.unconverted.push(rec.prompt_excerpt || rec.target || '(no excerpt)');
  }
  for (const s of Object.values(skills)) {
    s.remind.rate = s.remind.total ? Math.round((s.remind.converted / s.remind.total) * 100) / 100 : 0;
    for (const rule of Object.values(s.remind.rules)) rule.unconverted = rule.unconverted.reverse().slice(0, EXCERPT_CAP);
  }

  // The deny, verify, allow cycle, per session: how often it happens, how stale the marker was when
  // the gate finally accepted one, and how many denies it took to get there.
  const bySession = new Map();
  for (const { rec, skill } of gateLines) if (rec.session_id) push(bySession, `${skill} ${rec.session_id}`, rec);
  const perSkill = {};
  for (const [key, lines] of bySession) {
    const acc = (perSkill[key.split(' ')[0]] ||= { cycles: 0, ages: [], firstDenies: [] });
    let pending = 0;
    let seenAllow = false;
    for (const rec of lines) {
      if (rec.decision === 'deny') { pending++; continue; }
      // Denies before the FIRST allow of the session, which is 0 when the session was never denied:
      // leaving those sessions out would measure the cost of a deny rather than the cost of the gate.
      if (!seenAllow) acc.firstDenies.push(pending);
      if (pending > 0) {
        acc.cycles++;
        if (typeof rec.marker_age_s === 'number') acc.ages.push(rec.marker_age_s);
        pending = 0;
      }
      seenAllow = true;
    }
  }
  for (const [skill, acc] of Object.entries(perSkill)) {
    const c = skills[skill].gate.cycles;
    c.count = acc.cycles;
    c.median_marker_age_s = median(acc.ages);
    c.median_denies_before_first_allow = median(acc.firstDenies);
  }

  return { window, totals, skills, health, candidates: [] };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MIN_REMINDERS = 3;
const MIN_DENIES = 3;
const MIN_RUNS = 3;

export function candidates(records, agg, loaded) {
  const out = [];
  if (!records.length) return out;

  for (const [skill, s] of Object.entries(agg.skills)) {
    for (const [rule, r] of Object.entries(s.remind.rules)) {
      if (r.total >= MIN_REMINDERS && r.converted === 0) out.push({ kind: 'rule-never-converts', subject: rule, detail: `${r.total} reminders for ${skill}, 0 conversions` });
    }
    for (const [version, v] of Object.entries(s.run.versions)) {
      const bad = v.verdicts['not-safe'] || 0;
      const good = v.verdicts.safe || 0;
      // A minimum sample, like the other thresholds: the first not-safe run on a fresh version is a
      // bad afternoon, not evidence that the version is worse.
      if (v.total >= MIN_RUNS && bad > good) out.push({ kind: 'version-regression', subject: `${skill} ${version}`, detail: `${bad} not-safe vs ${good} safe over ${v.total} runs` });
    }
  }

  // A session denied again and again without the skill the gate asked for ever running: either the
  // message is not landing, or the gate is standing somewhere it should not.
  const denies = new Map();
  const ran = new Set();
  for (const r of records) {
    if (!r.session_id || !r.skill) continue;
    if (r.type === 'gate' && r.decision === 'deny') denies.set(`${r.skill} ${r.session_id}`, (denies.get(`${r.skill} ${r.session_id}`) || 0) + 1);
    if (r.type === 'invoke' || (r.type || 'run') === 'run') ran.add(`${r.skill} ${r.session_id}`);
  }
  for (const [key, n] of denies) {
    if (n < MIN_DENIES || ran.has(key)) continue;
    const [skill, session] = key.split(' ');
    out.push({ kind: 'gate-loop', subject: skill, detail: `session ${session}: ${n} denies, no ${skill} run` });
  }

  // The prompt already was the slash command: the pattern fired on the user's own invocation and
  // spent a reminder telling them to do what they had just done.
  for (const r of records) {
    if (r.type !== 'remind' || !r.skill) continue;
    const text = String(r.prompt_excerpt || '');
    if (new RegExp(`(^|\\s)/(?:[A-Za-z0-9_-]+:)?${escapeRe(r.skill)}\\b`, 'i').test(text)) out.push({ kind: 'self-echo', subject: r.rule || r.skill, detail: text });
  }

  // A pattern that matched nothing is either dead weight or written for a prompt shape that does not
  // occur. Either way it is a rule-table edit, not a mystery.
  if (loaded) {
    const fired = new Set(records.filter((r) => r.type === 'remind' && Number.isInteger(r.pattern_index)).map((r) => `${r.rule} #${r.pattern_index}`));
    const seen = new Set(records.map((r) => r.repo).filter(Boolean));
    for (const rule of loaded.rules) {
      if (rule.event !== 'prompt') continue;
      // A pattern cannot be called unused over a window that never entered its scope: a corp-only
      // rule matching nothing during a week spent in the portfolio says nothing about the pattern.
      // Scope is resolved by rules.mjs, the same call the hooks route on, so the review can never
      // drift from the table. `inScope(rule, null, …)` is the "everywhere" question: a `*` rule is in
      // scope even over a window whose records name no repo at all.
      const everywhere = inScope(rule, null, loaded.repoGroups);
      if (!everywhere && ![...seen].some((repo) => inScope(rule, repo, loaded.repoGroups))) continue;
      (rule.patterns || []).forEach((p, i) => {
        const subject = `${rule.id} #${i}`;
        if (!fired.has(subject)) out.push({ kind: 'pattern-unused', subject, detail: String(p).slice(0, 60) });
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- markdown

const pairs = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ');

export function renderMd(agg) {
  const w = agg.window;
  const L = ['# skill router · weekly review', `window ${w.since} → ${w.until} · ${w.days} days · window from ${w.source} · ${agg.totals.records} records`, ''];
  if (w.future) {
    L.push('window is empty (since is in the future). Nothing to review: fix the --since argument, or the watermark a review left ahead of the clock.');
    return L.join('\n');
  }
  if (!agg.totals.records) {
    L.push('nothing this week: no records in this window. Either the router is quiet or it is off, and `node router/selfcheck.mjs --cli` says which.');
    return L.join('\n');
  }
  L.push(`totals · invoke ${agg.totals.invoke} · remind ${agg.totals.remind} · run ${agg.totals.run} · gate ${agg.totals.gate} · annotation ${agg.totals.annotation}`, '');

  for (const name of Object.keys(agg.skills).sort()) {
    const s = agg.skills[name];
    L.push(`## ${name}`);
    if (s.invoke.total) L.push(`- invoke ${s.invoke.total} · user ${s.invoke.user} · router ${s.invoke.router} · model ${s.invoke.model}`);
    if (s.remind.total) {
      L.push(`- remind ${s.remind.total} · converted ${s.remind.converted} (${Math.round(s.remind.rate * 100)}%)`);
      for (const [rule, r] of Object.entries(s.remind.rules)) {
        L.push(`  - ${rule}: ${r.total} sent, ${r.converted} converted`);
        for (const e of r.unconverted) L.push(`    - unconverted: ${e}`);
      }
    }
    if (s.run.total) {
      L.push(`- run ${s.run.total} · ${pairs(s.run.verdicts)}`);
      for (const [v, x] of Object.entries(s.run.versions)) L.push(`  - version ${v}: ${x.total} run${x.total === 1 ? '' : 's'} · ${pairs(x.verdicts)}`);
      for (const [g, x] of Object.entries(s.run.gates)) L.push(`  - gates.${g}: ${pairs(x)}`);
      if (Object.keys(s.run.outcome_sums).length) L.push(`  - sums ${pairs(s.run.outcome_sums)}`);
      if (s.run.caught_total) {
        L.push(`  - caught ${s.run.caught_total}${s.run.caught_total > s.run.caught.length ? ` (first ${s.run.caught.length})` : ''}:`);
        for (const c of s.run.caught) L.push(`    - ${c}`);
      }
    }
    if (s.gate.total) {
      L.push(`- gate ${s.gate.total}`);
      if (Object.keys(s.gate.allow).length) L.push(`  - allow: ${pairs(s.gate.allow)}`);
      if (Object.keys(s.gate.deny).length) L.push(`  - deny: ${pairs(s.gate.deny)}`);
      if (s.gate.cycles.count) L.push(`  - deny to allow cycles ${s.gate.cycles.count} · median marker age at allow ${s.gate.cycles.median_marker_age_s ?? 'n/a'}s · median denies before the first allow ${s.gate.cycles.median_denies_before_first_allow ?? 'n/a'} (a session that was never denied counts 0)`);
      if (s.gate.overrides.count) {
        L.push(`  - override SKIP_VERIFY ${s.gate.overrides.count}:`);
        for (const c of s.gate.overrides.commands) L.push(`    - ${c}`);
      }
    }
    for (const [kind, items] of [['missed', s.annotation.missed], ['caught later', s.annotation.caught]]) {
      for (const a of items) L.push(`- annotation ${kind}: ${a.text} (ref ${a.ref}${a.by ? `, by ${a.by}` : ''})`);
    }
    L.push('');
  }

  L.push('## Candidates');
  if (!agg.candidates.length) L.push('- none: nothing in the window meets a candidate threshold.');
  for (const c of agg.candidates) L.push(`- ${c.kind} · ${c.subject} · ${c.detail}`);
  L.push('');
  L.push('## Health');
  L.push(`- self-check ${agg.health.ok} ok · ${agg.health.fail} failed`);
  if (agg.health.notes && Object.keys(agg.health.notes).length) L.push(`  - notes: ${pairs(agg.health.notes)}`);
  if (agg.health.last_failures.length) {
    L.push(`  - last failure ${agg.health.last_fail_ts}:`);
    for (const f of agg.health.last_failures) L.push(`    - ${f.check}: ${f.reason}`);
  }
  return L.join('\n');
}

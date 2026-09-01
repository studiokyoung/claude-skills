#!/usr/bin/env node
// ~/claude-skills/router/report.mjs — what the weekly /skill-review reads.
//   node report.mjs [--since <ISO>] [--md|--json] [--mark]
// Default window: since the last review's watermark, else the last seven days. Markdown by default;
// --mark on its own writes the watermark and prints nothing else, so a review closes in one command.
import { parseArgs } from './lib/args.mjs';
import { runsDir } from './lib/paths.mjs';
import { loadRules } from './lib/rules.mjs';
import { readRecords, aggregate, candidates, renderMd, readWatermark, writeWatermark } from './lib/report.mjs';

const USAGE = 'router: usage: node report.mjs [--since <ISO>] [--md|--json] [--mark]';
const argv = process.argv.slice(2);
// A typo must not read as "the default report": these are the numbers a review argues from.
const VALID = new Set(['since', 'md', 'json', 'mark']);
for (let i = 0; i < argv.length; i++) {
  const key = argv[i].startsWith('--') ? argv[i].slice(2) : null;
  if (key === null || !VALID.has(key)) { console.error(USAGE); process.exit(2); }
  if (key === 'since') i++; // its value is the next token, not a flag
}
const a = parseArgs(argv);

let sinceMs;
let source;
if (a.since !== undefined) {
  if (typeof a.since !== 'string' || Number.isNaN(Date.parse(a.since))) { console.error('router: --since needs an ISO timestamp (e.g. 2026-08-25T00:00:00Z)'); process.exit(2); }
  sinceMs = Date.parse(a.since);
  source = 'since';
} else {
  const wm = readWatermark();
  const last = wm && typeof wm.last === 'string' ? Date.parse(wm.last) : NaN;
  if (!Number.isNaN(last)) { sinceMs = last; source = 'watermark'; }
  else { sinceMs = Date.now() - 7 * 864e5; source = 'default'; }
}

const until = Date.now();
const window = {
  since: new Date(sinceMs).toISOString(),
  until: new Date(until).toISOString(),
  days: Math.round(((until - sinceMs) / 864e5) * 10) / 10,
  source,
};
// A rule table that will not load costs the pattern candidates, not the report.
let loaded = null;
try { loaded = loadRules(); } catch {}
const records = readRecords(runsDir(), sinceMs);
const agg = aggregate(records, window);
agg.candidates = candidates(records, agg, loaded);

const mark = a.mark === true;
const asJson = a.json === true;
// --mark on its own is the closing move of a review, not a request for another copy of it.
const wantReport = asJson || a.md === true || !mark;
let marked = null;
let previous = null;
if (mark) {
  previous = (readWatermark() || {}).last || null;
  marked = new Date().toISOString();
  writeWatermark(marked);
  if (asJson) agg.marked = marked;
}
if (asJson) process.stdout.write(JSON.stringify(agg, null, 2) + '\n');
else if (wantReport) process.stdout.write(renderMd(agg) + '\n');
if (mark && !asJson) process.stdout.write(`marked ${marked} (previous: ${previous || 'none'})\n`);

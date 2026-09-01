#!/usr/bin/env node
// ~/claude-skills/router/mark-pass.mjs — called by the verify skill after its table is final.
//   node mark-pass.mjs --root <repo-or-subdir> [--gates '<json>'] [--routes '<json>']   → writes .git/verify-pass
//   node mark-pass.mjs --root <repo-or-subdir> --clear                                 → removes it
import path from 'node:path';
import { failOpen, emit } from './lib/io.mjs';
import { parseArgs, safeJson } from './lib/args.mjs';
import { fingerprint, writeMarker, clearMarker, markerPath, toplevel } from './lib/git.mjs';
import { localIso } from './lib/records.mjs';

failOpen(() => {
  const a = parseArgs(process.argv.slice(2));
  const root = path.resolve(typeof a.root === 'string' ? a.root : process.cwd());
  if (!toplevel(root)) { emit({ ok: false, reason: 'not-a-git-repo' }); return; }
  if (a.clear) { clearMarker(root); emit({ cleared: true }); return; }
  // A malformed --gates/--routes is an error, never a silently null field: the marker is the record
  // of what /verify actually ran.
  const json = (k) => {
    if (a[k] === undefined) return { ok: true, value: null };
    const value = typeof a[k] === 'string' ? safeJson(a[k]) : null;
    return { ok: value !== null || a[k] === 'null', value };
  };
  // …except that routes are a plain list, and /verify hands them over as one far more often than
  // as JSON: `--routes /,/work/x` is accepted and split. A value that meant to be JSON (it opens
  // with a bracket) and does not parse is still an error, and so is an empty result — recording
  // `["[oops"]` as a checked route would be a lie in the record of what /verify ran. --gates is a
  // map, not a list, so no such leniency there.
  const routeList = () => {
    if (a.routes === undefined) return { ok: true, value: null };
    const strict = json('routes');
    if (strict.ok) return strict;
    if (typeof a.routes !== 'string' || /^\s*[[{]/.test(a.routes)) return { ok: false, value: null };
    const list = a.routes.split(',').map((s) => s.trim()).filter(Boolean);
    return { ok: list.length > 0, value: list };
  };
  const gates = json('gates');
  if (!gates.ok) { emit({ ok: false, reason: 'bad-gates-json' }); return; }
  const routes = routeList();
  if (!routes.ok) { emit({ ok: false, reason: 'bad-routes-json' }); return; }
  const fp = fingerprint(root);
  if (!fp) { emit({ ok: false, reason: 'fingerprint-failed' }); return; }
  const data = { fingerprint: fp, ts: localIso(), gates: gates.value, routes: routes.value };
  if (!writeMarker(root, data)) { emit({ ok: false, reason: 'marker-write-failed' }); return; }
  emit({ ok: true, marker: markerPath(root), fingerprint: fp });
});

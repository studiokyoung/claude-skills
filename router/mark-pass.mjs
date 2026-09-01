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
  const fp = fingerprint(root);
  if (!fp) { emit({ ok: false, reason: 'fingerprint-failed' }); return; }
  const data = { fingerprint: fp, ts: localIso(), gates: safeJson(a.gates), routes: safeJson(a.routes) };
  writeMarker(root, data);
  emit({ ok: true, marker: markerPath(root), fingerprint: fp });
});

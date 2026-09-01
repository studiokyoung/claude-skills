#!/usr/bin/env node
// ~/claude-skills/router/record-run.mjs — skills call this as their last step.
//   node record-run.mjs --skill verify --cwd <repo> [--prompt-id <id>] --json '{"verdict":"safe",...,"caught":[...]}'
//   node record-run.mjs --skill verify --type annotation --json '{"ref":"<run id>","missed":"...","by":"debrief 2026-09-02"}'
import path from 'node:path';
import { failOpen, emit } from './lib/io.mjs';
import { parseArgs, safeJson } from './lib/args.mjs';
import { repoOf } from './lib/rules.mjs';
import { gitContext } from './lib/git.mjs';
import { appendRecord, recordPath, normalizeSkill, readSkillVersion, inferSession } from './lib/records.mjs';

failOpen(() => {
  const a = parseArgs(process.argv.slice(2));
  const skill = normalizeSkill(typeof a.skill === 'string' ? a.skill : '');
  if (!skill) { emit({ ok: false, reason: 'missing --skill' }); return; }
  const body = safeJson(a.json);
  if (!body || typeof body !== 'object' || Array.isArray(body)) { emit({ ok: false, reason: 'invalid --json' }); return; }
  const type = a.type === 'annotation' ? 'annotation' : 'run';
  const cwd = path.resolve(typeof a.cwd === 'string' ? a.cwd : process.cwd());
  const repo = repoOf(cwd);

  let rec;
  if (type === 'annotation') {
    if (!body.ref) { emit({ ok: false, reason: 'missing ref' }); return; }
    rec = { type, ref: String(body.ref), repo };
    if (body.missed !== undefined) rec.missed = body.missed;
    if (body.caught !== undefined) rec.caught = body.caught;
    rec.by = body.by || 'debrief';
    if (body.note !== undefined) rec.note = body.note;
  } else {
    const { caught, ...outcome } = body;
    const session = inferSession(repo);
    rec = {
      type,
      version: typeof a.version === 'string' ? a.version : readSkillVersion(skill, typeof a['skill-md'] === 'string' ? a['skill-md'] : undefined),
      repo,
      cwd,
      session_id: session ? session.session_id : null,
      session_inferred: Boolean(session),
      // Passed by a skill that knows which prompt it is answering; null until one does.
      prompt_id: typeof a['prompt-id'] === 'string' ? a['prompt-id'] : null,
      git: gitContext(cwd),
      outcome,
      // A skill that reports one catch as a bare string still gets a list, not a dropped record.
      caught: Array.isArray(caught) ? caught : caught == null ? [] : [String(caught)],
    };
  }
  let saved;
  try { saved = appendRecord(skill, rec); }
  catch { emit({ ok: false, reason: 'write-failed' }); return; }
  emit({ ok: true, id: saved.id, file: recordPath(skill) });
});

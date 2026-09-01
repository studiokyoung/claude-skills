#!/usr/bin/env node
// ~/claude-skills/router/pre-tool.mjs — PreToolUse hook (matcher Bash|Write)
import { failOpen, readStdin, emit, log } from './lib/io.mjs';
import { loadRules } from './lib/rules.mjs';
import { loadLedger, saveLedger } from './lib/ledger.mjs';
import { parseCommand, bashWriteTargetsWithBase } from './lib/commit.mjs';
import { decideCommit, decideBackstop } from './lib/gate.mjs';
import { appendRecord, excerpt, ageSeconds } from './lib/records.mjs';

const deny = (reason) => emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
const context = (text) => emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } });

failOpen(async () => {
  const input = await readStdin();
  if (!input || (input.hook_event_name && input.hook_event_name !== 'PreToolUse')) return;
  const { tool_name, tool_input } = input;
  // A broken/missing rules file must stay fail-open, but not silently: leave a trace.
  let loaded;
  try { loaded = loadRules(); } catch (e) { log('rules', '-', null, 'rules-load-failed', e.message); return; }

  let targets = [];
  if (tool_name === 'Bash') {
    const command = tool_input && tool_input.command;
    const parsed = parseCommand(command);
    if (parsed.isCommit) {
      const d = decideCommit(loaded, input, parsed);
      log('commit', d.ruleId, d.repo, d.decision, d.why);
      // Out of scope means no gate stood here: nothing was decided, so there is nothing to record.
      // Everything else is recorded before the deny, and a failing buffer never holds the deny back.
      if (d.skill) {
        try {
          appendRecord(d.skill, {
            type: 'gate', repo: d.repo, session_id: input.session_id, prompt_id: input.prompt_id || null,
            decision: d.decision, why: d.why, candidates: d.cand ? d.cand.length : null,
            docs_only: d.why === 'docs-only', marker_ts: d.markerTs, marker_age_s: ageSeconds(d.markerTs),
            command_excerpt: excerpt(command, 120),
          });
        } catch (e) { log('records', d.ruleId, d.repo, 'record-failed', e && e.message); }
      }
      if (d.decision === 'deny') deny(d.message);
      return;
    }
    targets = bashWriteTargetsWithBase(command);
  } else if (tool_name === 'Write') {
    targets = tool_input && tool_input.file_path ? [{ target: tool_input.file_path, base: null }] : [];
  } else {
    return;
  }

  if (targets.length === 0) return;
  const ledger = loadLedger(input.session_id);
  const hit = decideBackstop(loaded, ledger, input, targets);
  if (!hit) return;
  ledger.reminded[hit.rule.id] = { skill: hit.rule.skill, prompt_id: input.prompt_id || null, ts: new Date().toISOString() };
  ledger.repo = hit.repo; ledger.cwd = input.cwd || null;
  saveLedger(ledger);
  const asContext = loaded.preToolUseContext === 'additionalContext';
  log('new-file', hit.rule.id, hit.repo, asContext ? 'remind' : 'deny-once', hit.rel);
  try {
    appendRecord(hit.rule.skill, { type: 'remind', rule: hit.rule.id, delivery: 'new-file', repo: hit.repo, session_id: input.session_id, prompt_id: input.prompt_id || null, pattern_index: null, target: hit.rel });
  } catch (e) { log('records', hit.rule.id, hit.repo, 'record-failed', e && e.message); }
  const msg = `[skill-router] ${hit.rule.message}`;
  if (asContext) context(msg);
  else deny(`${msg} One-time reminder: retry the same call to proceed.`);
});

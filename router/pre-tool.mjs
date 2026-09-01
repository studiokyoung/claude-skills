#!/usr/bin/env node
// ~/claude-skills/router/pre-tool.mjs — PreToolUse hook (matcher Bash|Write)
import { failOpen, readStdin, emit, log } from './lib/io.mjs';
import { loadRules } from './lib/rules.mjs';
import { loadLedger, saveLedger } from './lib/ledger.mjs';
import { parseCommand, bashWriteTargets } from './lib/commit.mjs';
import { decideCommit, decideBackstop } from './lib/gate.mjs';

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
      if (d.decision === 'deny') deny(d.message);
      return;
    }
    targets = bashWriteTargets(command);
  } else if (tool_name === 'Write') {
    targets = tool_input && tool_input.file_path ? [tool_input.file_path] : [];
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
  const msg = `[skill-router] ${hit.rule.message}`;
  if (loaded.preToolUseContext === 'additionalContext') {
    log('new-file', hit.rule.id, hit.repo, 'remind', hit.rel);
    context(msg);
  } else {
    log('new-file', hit.rule.id, hit.repo, 'deny-once', hit.rel);
    deny(`${msg} One-time reminder: retry the same call to proceed.`);
  }
});

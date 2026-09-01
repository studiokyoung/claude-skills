#!/usr/bin/env node
// ~/claude-skills/router/on-prompt.mjs — UserPromptSubmit hook
import { failOpen, readStdin, emit, log } from './lib/io.mjs';
import { loadRules, repoOf, knownSkills } from './lib/rules.mjs';
import { loadLedger, saveLedger } from './lib/ledger.mjs';
import { appendRecord, excerpt } from './lib/records.mjs';
import { detectUserSkill, planReminders } from './lib/prompt.mjs';

failOpen(async () => {
  const input = await readStdin();
  if (!input || (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit')) return;
  const { session_id, prompt_id, cwd, prompt } = input;
  // Neither text to match nor a session to key a ledger by: not a prompt this hook can act on.
  if (prompt === undefined && session_id === undefined) return;
  // Claude Code delivers harness-generated turns through this hook too (background task
  // notifications, system reminders). Nobody typed them, so evaluating one would spend the
  // session's single reminder, or bank an invoke, on text the user never wrote.
  const head = String(prompt || '').trim();
  if (/^<(?:task-notification|system-reminder)/.test(head) || head.slice(0, 200).includes('[SYSTEM NOTIFICATION - NOT USER INPUT]')) return;
  const repo = repoOf(cwd);
  // A broken/missing rules file must stay fail-open, but not silently: leave a trace.
  let loaded;
  try { loaded = loadRules(); } catch (e) { log('rules', '-', repo, 'rules-load-failed', e && e.message); return; }
  const ledger = loadLedger(session_id);
  ledger.repo = repo;
  ledger.cwd = cwd || null;
  const now = new Date().toISOString();

  const typed = detectUserSkill(prompt, knownSkills(loaded));
  if (typed) {
    ledger.user_invoked.push({ skill: typed, prompt_id: prompt_id || null, ts: now });
    saveLedger(ledger);
    // Logged before the record: a failing append must not also lose the trace of the invocation.
    log('prompt', '-', repo, 'user-invoked', typed);
    appendRecord(typed, { type: 'invoke', repo, session_id, prompt_id: prompt_id || null, trigger: 'user' });
    return;
  }

  // The reminder is injected as context and comes back inside the next payload the hook sees.
  // Matching our own words would re-fire the rules that wrote them.
  const echo = String(prompt || '').includes('[skill-router]');
  const { messages, fired } = echo ? { messages: [], fired: [] } : planReminders(loaded, ledger, repo, prompt);
  for (const f of fired) ledger.reminded[f.ruleId] = { skill: f.skill, prompt_id: prompt_id || null, ts: now };
  saveLedger(ledger);
  for (const f of fired) log('prompt', f.ruleId, repo, 'remind');
  // Logged first, emitted last: a failing record buffer costs a line in the log, never the reminder.
  for (const f of fired) {
    try {
      appendRecord(f.skill, { type: 'remind', rule: f.ruleId, delivery: 'prompt', repo, session_id, prompt_id: prompt_id || null, pattern_index: f.patternIndex, prompt_excerpt: excerpt(prompt, 160) });
    } catch (e) { log('records', f.ruleId, repo, 'record-failed', e && e.message); }
  }
  if (messages.length) {
    emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: messages.join('\n') } });
  }
});

#!/usr/bin/env node
// ~/claude-skills/router/on-prompt.mjs — UserPromptSubmit hook
import { failOpen, readStdin, emit, log } from './lib/io.mjs';
import { loadRules, repoOf, knownSkills } from './lib/rules.mjs';
import { loadLedger, saveLedger } from './lib/ledger.mjs';
import { appendRecord } from './lib/records.mjs';
import { detectUserSkill, planReminders } from './lib/prompt.mjs';

failOpen(async () => {
  const input = await readStdin();
  if (!input || (input.hook_event_name && input.hook_event_name !== 'UserPromptSubmit')) return;
  const { session_id, prompt_id, cwd, prompt } = input;
  const loaded = loadRules();
  const repo = repoOf(cwd);
  const ledger = loadLedger(session_id);
  ledger.repo = repo;
  ledger.cwd = cwd || null;
  const now = new Date().toISOString();

  const typed = detectUserSkill(prompt, knownSkills(loaded));
  if (typed) {
    ledger.user_invoked.push({ skill: typed, prompt_id: prompt_id || null, ts: now });
    saveLedger(ledger);
    appendRecord(typed, { type: 'invoke', repo, session_id, prompt_id: prompt_id || null, trigger: 'user' });
    log('prompt', '-', repo, 'user-invoked', typed);
    return;
  }

  const { messages, fired } = planReminders(loaded, ledger, repo, prompt);
  for (const f of fired) ledger.reminded[f.ruleId] = { skill: f.skill, prompt_id: prompt_id || null, ts: now };
  saveLedger(ledger);
  for (const f of fired) log('prompt', f.ruleId, repo, 'remind');
  if (messages.length) {
    emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: messages.join('\n') } });
  }
});

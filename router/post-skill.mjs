#!/usr/bin/env node
// ~/claude-skills/router/post-skill.mjs — PostToolUse hook (matcher Skill)
import { failOpen, readStdin, log } from './lib/io.mjs';
import { loadRules, repoOf, knownSkills } from './lib/rules.mjs';
import { loadLedger, saveLedger, wasReminded } from './lib/ledger.mjs';
import { skillFromToolInput, appendRecord } from './lib/records.mjs';

failOpen(async () => {
  const input = await readStdin();
  if (!input || input.tool_name !== 'Skill') return;
  if (input.hook_event_name && input.hook_event_name !== 'PostToolUse') return;
  const skill = skillFromToolInput(input.tool_input);
  if (!skill) return;
  const { session_id, prompt_id, cwd } = input;
  const loaded = loadRules();
  const repo = repoOf(cwd);
  const ledger = loadLedger(session_id);
  ledger.repo = repo; ledger.cwd = cwd || null;

  const typedSame = ledger.user_invoked.some((u) => u.skill === skill && u.prompt_id === (prompt_id || null));
  const trigger = typedSame ? 'user' : (wasReminded(ledger, skill) ? 'router' : 'model');
  ledger.skills_ran.push({ skill, prompt_id: prompt_id || null, ts: new Date().toISOString(), trigger });
  saveLedger(ledger);

  if (knownSkills(loaded).includes(skill) && trigger !== 'user') {
    appendRecord(skill, { type: 'invoke', repo, session_id, prompt_id: prompt_id || null, trigger });
  }
  log('skill', '-', repo, 'invoke', `${skill} ${trigger}`);
});

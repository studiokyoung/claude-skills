// ~/claude-skills/router/lib/prompt.mjs
import { rulesFor, matchPromptIndex } from './rules.mjs';
import { hasRun } from './ledger.mjs';
import { normalizeSkill } from './records.mjs';

const RAW = /^\s*\/([A-Za-z0-9][A-Za-z0-9:_-]*)/;
const WRAPPED = /^\s*<command-(?:name|message)>\s*\/?([A-Za-z0-9][A-Za-z0-9:_-]*)\s*<\/command-(?:name|message)>/;

export function detectUserSkill(prompt, known) {
  const text = String(prompt || '');
  const m = text.match(RAW) || text.match(WRAPPED);
  if (!m) return null;
  const name = normalizeSkill(m[1]);
  return known.includes(name) ? name : null;
}

export function planReminders(loaded, ledger, repo, prompt) {
  const messages = [];
  const fired = [];
  for (const rule of rulesFor(loaded, 'prompt', repo)) {
    if (rule.mode !== 'remind') continue;
    if (!rule.message) continue;
    if (rule.once_per_session && ledger.reminded[rule.id]) continue;
    if (rule.unless_ran && hasRun(ledger, rule.unless_ran)) continue;
    const patternIndex = matchPromptIndex(rule, prompt);
    if (patternIndex < 0) continue;
    messages.push(`[skill-router] ${rule.message}`);
    fired.push({ ruleId: rule.id, skill: rule.skill, patternIndex });
  }
  return { messages, fired };
}

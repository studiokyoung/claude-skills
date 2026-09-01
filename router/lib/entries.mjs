// ~/claude-skills/router/lib/entries.mjs
// The hook registration table: what install.mjs writes into a settings file, and what selfcheck.mjs
// looks for there. One source of truth, so a health check can never drift from the install it checks.
export const HOOK_ENTRIES = [
  { event: 'UserPromptSubmit', matcher: null, script: 'on-prompt.mjs', timeout: 5 },
  { event: 'PreToolUse', matcher: 'Bash|Write', script: 'pre-tool.mjs', timeout: 5 },
  { event: 'PostToolUse', matcher: 'Skill', script: 'post-skill.mjs', timeout: 5 },
  // Longer, because this one spawns the other three against temp directories before it answers.
  { event: 'SessionStart', matcher: null, script: 'selfcheck.mjs', timeout: 10 },
];

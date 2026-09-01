// ~/claude-skills/router/probe.mjs
// Appends every hook payload it receives to $ROUTER_STATE_DIR/probe.log (default ~/.claude/router-state/probe.log).
// argv[2] = a label. Label "ctx-pre" also answers with a bare additionalContext (no permissionDecision).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  try {
    const dir = process.env.ROUTER_STATE_DIR || path.join(os.homedir(), '.claude', 'router-state');
    fs.mkdirSync(dir, { recursive: true });
    let stdin; try { stdin = JSON.parse(data); } catch { stdin = data; }
    fs.appendFileSync(path.join(dir, 'probe.log'),
      JSON.stringify({ ts: new Date().toISOString(), label: process.argv[2] || '', stdin }) + '\n');
    if (process.argv[2] === 'ctx-pre') {
      fs.writeSync(1, JSON.stringify({ hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'PROBE-CTX-7741: if you can read this sentence, include the exact token PROBE-CTX-7741 in your final answer.',
      } }) + '\n');
    }
  } catch {}
  process.exit(0);
});

// ~/claude-skills/router/lib/io.mjs
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';

// Runs main and ALWAYS exits 0. No output on failure. Never throws to the harness.
export function failOpen(main) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
  Promise.resolve()
    .then(() => main())
    .then(() => process.exit(0), () => process.exit(0));
}

// Resolves the parsed stdin JSON, or null (empty / invalid / no stdin within timeoutMs).
export function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { resolve(data.trim() ? JSON.parse(data) : null); } catch { resolve(null); }
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch { finish(); }
  });
}

// One JSON line on fd 1, synchronously (pipes are async on macOS; exit() must not truncate).
export function emit(obj) {
  fs.writeSync(1, JSON.stringify(obj) + '\n');
}

// Append one decision line: ts, event, ruleId, repo, decision, detail. Rotates at 1 MB.
export function log(event, ruleId, repo, decision, detail = '') {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'router.log');
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1'); } catch {}
    const clean = String(detail).replace(/\s+/g, ' ').trim().slice(0, 300);
    fs.appendFileSync(file, [new Date().toISOString(), event, ruleId || '-', repo || '-', decision, clean].join('\t') + '\n');
  } catch {}
}

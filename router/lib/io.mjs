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

// Resolves the parsed stdin JSON object, or null (empty / non-object / invalid / no stdin within timeoutMs).
export function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { const v = data.trim() ? JSON.parse(data) : null; resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : null); } catch { resolve(null); }
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

// One JSON line on fd 1, synchronously and completely (pipes are async on macOS: writeSync may
// write short or throw EAGAIN once stdout is non-blocking; exit() must not truncate).
export function emit(obj) {
  const buf = Buffer.from(JSON.stringify(obj) + '\n');
  let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(1, buf, off, buf.length - off); }
    catch (e) { if (e.code !== 'EAGAIN') throw e; }
  }
}

// Append one decision line: ts, event, ruleId, repo, decision, detail. Rotates at 1 MB.
export function log(event, ruleId, repo, decision, detail = '') {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'router.log');
    try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.1'); } catch {}
    const col = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
    fs.appendFileSync(file, [new Date().toISOString(), col(event), col(ruleId) || '-', col(repo) || '-', col(decision), col(detail).slice(0, 300)].join('\t') + '\n');
  } catch {}
}

// ~/claude-skills/router/lib/ledger.mjs
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';

export function ledgerFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(stateDir(), `${safe}.json`);
}

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function loadLedger(sessionId) {
  try {
    const l = JSON.parse(fs.readFileSync(ledgerFile(sessionId), 'utf8'));
    if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error('bad ledger');
    l.session_id = l.session_id || sessionId;
    l.reminded = obj(l.reminded); l.user_invoked = arr(l.user_invoked); l.skills_ran = arr(l.skills_ran);
    return l;
  } catch {
    return { session_id: sessionId, created: new Date().toISOString(), repo: null, cwd: null, reminded: {}, user_invoked: [], skills_ran: [] };
  }
}

// Merge-on-write: hooks overlap (parallel tool calls), so re-read and union before writing.
function mergeLedgers(disk, mem) {
  const key = (e) => `${e && e.skill}|${(e && e.prompt_id) ?? ''}|${(e && e.ts) ?? ''}`;
  const union = (a, b) => { const seen = new Set(); return [...arr(a), ...arr(b)].filter((e) => { const k = key(e); if (seen.has(k)) return false; seen.add(k); return true; }); };
  return { ...disk, ...mem, reminded: { ...obj(disk.reminded), ...obj(mem.reminded) }, user_invoked: union(disk.user_invoked, mem.user_invoked), skills_ran: union(disk.skills_ran, mem.skills_ran) };
}

export function saveLedger(ledger) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const file = ledgerFile(ledger.session_id);
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const merged = disk && typeof disk === 'object' && !Array.isArray(disk) ? mergeLedgers(disk, ledger) : ledger;
  fs.writeFileSync(file, JSON.stringify(merged));
  prune();
}

export function hasRun(ledger, skill) {
  return ledger.skills_ran.some((r) => r.skill === skill) || ledger.user_invoked.some((u) => u.skill === skill);
}

export function wasReminded(ledger, skill) {
  return Object.values(ledger.reminded).some((v) => v && v.skill === skill);
}

export function prune(maxAgeDays = 7) {
  try {
    const dir = stateDir();
    const cutoff = Date.now() - maxAgeDays * 864e5;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

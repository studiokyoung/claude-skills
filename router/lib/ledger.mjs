// ~/claude-skills/router/lib/ledger.mjs
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.mjs';

export function ledgerFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(stateDir(), `${safe}.json`);
}

export function loadLedger(sessionId) {
  try {
    const l = JSON.parse(fs.readFileSync(ledgerFile(sessionId), 'utf8'));
    l.reminded ||= {}; l.user_invoked ||= []; l.skills_ran ||= [];
    return l;
  } catch {
    return { session_id: sessionId, created: new Date().toISOString(), repo: null, cwd: null, reminded: {}, user_invoked: [], skills_ran: [] };
  }
}

export function saveLedger(ledger) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(ledgerFile(ledger.session_id), JSON.stringify(ledger));
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

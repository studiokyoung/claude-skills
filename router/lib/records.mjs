// ~/claude-skills/router/lib/records.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runsDir, skillsDir, stateDir } from './paths.mjs';

export function newId(skill) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${skill}-${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

export function localIso(d = new Date()) {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + offMin * 60000).toISOString().replace('Z', '');
  return `${local}${sign}${pad(offMin / 60)}:${pad(offMin % 60)}`;
}

// What a record keeps of the text that triggered it: whitespace collapsed and cut to `max`, so one
// line stays readable and the whole prompt never lands in the buffer.
export function excerpt(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Seconds since an ISO timestamp, never negative (a clock that moved is not a negative age), and
// null when there is no timestamp or it does not parse.
export function ageSeconds(ts, now = Date.now()) {
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 1000));
}

// The buffer file for one skill: sanitized, and never an empty name (`unknown.jsonl`, the same
// fallback the session ledger uses), so a nameless record still lands somewhere readable.
export function recordPath(skill) {
  const safe = String(skill || '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
  return path.join(runsDir(), `${safe}.jsonl`);
}

export function appendRecord(skill, rec) {
  fs.mkdirSync(runsDir(), { recursive: true });
  const full = { ...rec, type: rec.type || 'run', id: rec.id || newId(skill), ts: rec.ts || localIso(), skill };
  fs.appendFileSync(recordPath(skill), JSON.stringify(full) + '\n');
  return full;
}

export function normalizeSkill(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  return s.includes(':') ? s.split(':').pop().trim() : s;
}

// Task 0 (F1) pins which key the Skill tool uses; keep the fallbacks so a rename does not silence the ledger.
export function skillFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const raw = toolInput.skill ?? toolInput.name ?? toolInput.command ?? null;
  const s = normalizeSkill(raw);
  return s || null;
}

export function readSkillVersion(skill, skillMdPath) {
  const p = skillMdPath || path.join(skillsDir(), skill, 'SKILL.md');
  try {
    const text = fs.readFileSync(p, 'utf8');
    const fm = text.split(/^---\s*$/m)[1] || '';
    const m = fm.match(/^\s*version:\s*["']?([^"'\n]+)/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

export function inferSession(repo, maxAgeMs = 3 * 3600e3) {
  if (!repo) return null;
  try {
    const dir = stateDir();
    let best = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > maxAgeMs) continue;
      let l; try { l = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (!l || l.repo !== repo || !l.session_id) continue;
      if (!best || st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, session_id: l.session_id };
    }
    return best ? { session_id: best.session_id, inferred: true } : null;
  } catch {
    return null;
  }
}

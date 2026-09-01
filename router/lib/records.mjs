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

export function appendRecord(skill, rec) {
  const dir = runsDir();
  fs.mkdirSync(dir, { recursive: true });
  const full = { type: rec.type || 'run', id: rec.id || newId(skill), ts: rec.ts || localIso(), skill, ...rec };
  fs.appendFileSync(path.join(dir, `${skill}.jsonl`), JSON.stringify(full) + '\n');
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

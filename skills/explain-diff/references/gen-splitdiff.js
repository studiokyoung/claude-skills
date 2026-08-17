#!/usr/bin/env node
// explain-diff html renderer. GitHub-style split diff with per-file meaning notes.
//
// Usage: node gen-splitdiff.js <config.json> <out.html>
//
// config.json schema (all text fields are HTML, so escape user content yourself):
// {
//   "repo": "/abs/path/to/git/repo",
//   "title": "page <h1>",
//   "subtitle": "one line under the title, put the verdict-count line here",
//   "footer": "closing line (next actions)",
//   "sections": [
//     { "id": "309", "heading": "#309 · ISSUE-42, retry on a flaky network", "range": "A..B" }, // PR-shaped
//     { "id": "1", "heading": "feff14e, add the comment convention", "range": "X~1..X" }  // bare commit: short sha, then summary
//   ],
//   "notes": { "<sectionId>:<repo-relative-path>": "<html explanation>" }
// }
// Prints matched/unused note counts at the end. An unused key means a typo'd
// path and a silently dropped note; fix the key and re-run.
//
// Note-writing rules (the skill's html section owns these, the script only
// prints the counts): plain language for someone who did not live the session,
// no session-coined shorthand, code identifiers in <code>. Shape: what changed,
// then why, then what was verified or not verified (⚠️ for open questions).
const { execFileSync } = require('child_process');
const fs = require('fs');

const [, , cfgPath, OUT] = process.argv;
if (!cfgPath || !OUT) {
  console.error('usage: gen-splitdiff.js <config.json> <out.html>');
  process.exit(2);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseFileDiff(chunk) {
  const lines = chunk.split('\n');
  let path = null, hunks = [], cur = null, adds = 0, dels = 0;
  for (const l of lines) {
    if (l.startsWith('diff --git ')) {
      const m = l.match(/ b\/(.+)$/); path = m ? m[1] : null;
    } else if (l.startsWith('@@')) {
      const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      cur = { oldStart: +m[1], newStart: +m[2], ctx: m[3].trim(), lines: [] };
      hunks.push(cur);
    } else if (cur && (l.startsWith(' ') || l.startsWith('+') || l.startsWith('-'))) {
      cur.lines.push(l);
      if (l[0] === '+') adds++; else if (l[0] === '-') dels++;
    }
  }
  return { path, hunks, adds, dels };
}

function renderHunk(h) {
  const rows = [];
  let ol = h.oldStart, nl = h.newStart, i = 0;
  const L = h.lines;
  while (i < L.length) {
    if (L[i][0] === ' ') {
      rows.push({ ln: ol++, lt: L[i].slice(1), rn: nl++, rt: L[i].slice(1), cls: 'ctx' });
      i++;
    } else {
      const del = [], add = [];
      while (i < L.length && L[i][0] === '-') { del.push(L[i].slice(1)); i++; }
      while (i < L.length && L[i][0] === '+') { add.push(L[i].slice(1)); i++; }
      const n = Math.max(del.length, add.length);
      for (let k = 0; k < n; k++) {
        rows.push({
          ln: k < del.length ? ol++ : null, lt: k < del.length ? del[k] : null,
          rn: k < add.length ? nl++ : null, rt: k < add.length ? add[k] : null,
          cls: 'chg',
        });
      }
    }
  }
  let html = `<div class="hunkhdr mono">@@ ${h.ctx ? esc(h.ctx) : ''}</div><table class="split"><colgroup><col class="cn"><col class="cc"><col class="cn"><col class="cc"></colgroup>`;
  for (const r of rows) {
    const lcls = r.lt === null ? 'empty' : (r.cls === 'chg' ? 'del' : 'ctx');
    const rcls = r.rt === null ? 'empty' : (r.cls === 'chg' ? 'add' : 'ctx');
    html += `<tr><td class="num ${lcls}">${r.ln ?? ''}</td><td class="code ${lcls}">${r.lt !== null ? esc(r.lt) || '&nbsp;' : ''}</td>` +
            `<td class="num ${rcls}">${r.rn ?? ''}</td><td class="code ${rcls}">${r.rt !== null ? esc(r.rt) || '&nbsp;' : ''}</td></tr>`;
  }
  return html + '</table>';
}

let body = '', toc = '';
const usedNotes = new Set();
for (const sec of cfg.sections) {
  const raw = execFileSync('git', ['-C', cfg.repo, 'diff', '-M', '-U3', sec.range], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const files = raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git ')).map(parseFileDiff).filter((f) => f.path);
  body += `<section class="pr" id="s${sec.id}"><h2>${sec.heading} <span class="mono range">${esc(sec.range)}</span></h2>`;
  toc += `<div class="tocpr"><a href="#s${sec.id}">${sec.heading} (${files.length} files)</a></div>`;
  for (const f of files) {
    const noteKey = `${sec.id}:${f.path}`;
    const note = (cfg.notes || {})[noteKey] || '';
    if (note) usedNotes.add(noteKey);
    body += `<details class="file" open><summary><span class="fp mono">${esc(f.path)}</span><span class="stat"><b class="a">+${f.adds}</b> <b class="d">−${f.dels}</b></span></summary>`;
    if (note) body += `<div class="note">${note}</div>`;
    for (const h of f.hunks) body += renderHunk(h);
    body += `</details>`;
  }
  body += '</section>';
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cfg.title)}</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--card:#f6f8fa;
 --addbg:#e6ffec;--addnum:#ccffd8;--delbg:#ffebe9;--delnum:#ffd7d5;--notebg:#ddf4ff;--noteline:#54aeff}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--card:#151b23;
 --addbg:#12261e;--addnum:#1b4332;--delbg:#25171c;--delnum:#542426;--notebg:#121d2f;--noteline:#1f6feb}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Segoe UI",sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:28px 18px 90px}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace}
h1{font-size:19px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin-bottom:14px}
.toc{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.tocpr a{display:inline-block;padding:5px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);text-decoration:none;font-size:13px}
.pr{margin-top:26px}
.pr h2{font-size:16px;border-bottom:1px solid var(--line);padding-bottom:8px}
.pr h2 .range{font-size:12px;color:var(--muted);font-weight:400;margin-left:8px}
.file{border:1px solid var(--line);border-radius:8px;margin:12px 0;background:var(--bg);overflow:hidden}
.file summary{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 12px;background:var(--card);cursor:pointer;list-style:none;border-bottom:1px solid var(--line)}
.file summary::-webkit-details-marker{display:none}
.fp{font-size:13px;font-weight:600;word-break:break-all}
.stat{font-size:12px;white-space:nowrap}.stat .a{color:#1a7f37}.stat .d{color:#d1242f}
@media(prefers-color-scheme:dark){.stat .a{color:#3fb950}.stat .d{color:#f85149}}
.note{padding:10px 14px;background:var(--notebg);border-left:3px solid var(--noteline);font-size:13.5px;line-height:1.65}
.note code{background:rgba(128,128,128,.15);padding:0 4px;border-radius:4px;font-size:12px}
.hunkhdr{padding:4px 12px;background:var(--card);color:var(--muted);font-size:12px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
table.split{width:100%;border-collapse:collapse;table-layout:fixed}
col.cn{width:44px}col.cc{width:calc(50% - 44px)}
td{vertical-align:top;font-size:12px;line-height:1.5}
td.num{color:var(--muted);text-align:right;padding:0 7px;user-select:none;font-family:ui-monospace,Menlo,monospace}
td.code{font-family:ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-all;padding:0 8px;border-left:1px solid var(--line)}
td.del{background:var(--delbg)}td.num.del{background:var(--delnum)}
td.add{background:var(--addbg)}td.num.add{background:var(--addnum)}
td.empty{background:var(--card)}
footer{margin-top:28px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><div class="wrap">
<h1>${esc(cfg.title)}</h1>
<div class="sub">${cfg.subtitle || ''}</div>
<div class="toc">${toc}</div>
${body}
<footer>${cfg.footer || ''}</footer>
</div></body></html>`;

fs.writeFileSync(OUT, html);
const allNoteKeys = Object.keys(cfg.notes || {});
const unused = allNoteKeys.filter((k) => !usedNotes.has(k));
console.log('WROTE', OUT, html.length, 'bytes');
console.log(`notes: ${usedNotes.size}/${allNoteKeys.length} matched`);
if (unused.length) console.log('UNUSED NOTE KEYS (typo?):', unused.join(', '));

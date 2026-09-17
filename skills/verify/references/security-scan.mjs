#!/usr/bin/env node
// Secret / tracked-env / dependency-audit scan for the /verify skill.
//
// The deterministic gates say whether the tree compiles and runs; none of them
// says whether the change is about to publish a credential. A .gitignore entry
// is not a gate — it is silent, it only covers the names someone remembered,
// and it says nothing about what is already tracked or about the added lines
// sitting in the index right now. This reads those lines instead.
//
// Usage:
//   node security-scan.mjs [--root <gitToplevel>] [--no-audit]
//
// Scans, in order:
//   a. secrets — the ADDED lines of `git diff` and `git diff --cached`, plus the
//      full content of untracked, non-ignored files. Binaries, node_modules,
//      lockfiles, *.min.* and anything over 2MB are skipped: they are noise, and
//      a minified bundle matches every generic pattern at once.
//   b. env files that are TRACKED (the .gitignore-only guard's blind spot),
//      minus the .env.example / .sample / .template family, which are meant to
//      be committed.
//   c. a production dependency audit, per PACKAGE — the scan root when it owns a
//      lockfile, otherwise every tracked package in the repo, since the git
//      toplevel is frequently not the npm project root.
//
// Findings are MASKED (first 4 chars + length). The raw value is never printed:
// a gate that echoes the credential into a transcript has leaked it a second
// time. A line carrying a `verify:allow-secret` comment is skipped entirely —
// that is the documented escape hatch for fixtures and docs samples.
//
// Prints one JSON object as the last stdout line:
//   {"secrets":[{"file","line","pattern","masked"}],"envTracked":[...],
//    "audit":{"status":"ok"|"partial"|"skip","high","critical",
//             "packages":[{"dir","status","high","critical","reason"?}],"reason"?},
//    "verdict":"PASS"|"FAIL","scanned":{"files":n,"lines":n}}
// Paths are reported relative to the git TOPLEVEL, and a --root below it narrows
// the scan to that subtree by pathspec (so every git call shares one base).
// Exit codes: 0 PASS · 1 FAIL · 2 not a git repo (emitted as verdict FAIL).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const AUDIT_TIMEOUT_MS = 90_000

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}
function emit(obj) {
  console.log(JSON.stringify(obj))
}

const root = path.resolve(arg('root', process.cwd()))
const wantAudit = !flag('no-audit')

// --- what never gets scanned -------------------------------------------------
// A lockfile or a minified bundle is a wall of high-entropy strings; scanning it
// produces findings nobody can act on and trains the reader to ignore the gate.
const SKIP_PATH =
  /(^|\/)node_modules\/|(^|\/)\.git\/|\.min\.[A-Za-z0-9]+$|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|composer\.lock|poetry\.lock|Gemfile\.lock)$/

// --- the patterns ------------------------------------------------------------
// Each is a provider-shaped token, so a hit is a hit. The last one is the
// generic shape (`secret: "…"`), which needs the placeholder filter below or it
// fires on every config template in the repo.
// A masked value (`password: "************"`) is the opposite of a leak — it is
// someone having already redacted it. Six or more of the same filler character.
const MASK_FILLER = /([*xX#])\1{5,}/
const PLACEHOLDER = /process\.env|\$\{|<|xxx|your-|example|changeme|redacted/i

// Every prefix-shaped token gets a LEFT boundary. Without one, `sk-` matches
// inside any hyphenated slug — a real photo-credit URL ending
// `…-desk-and-chairs-Fdku_oMrDvk` was reported as an OpenAI key, and a gate that
// cries wolf on a stock-photo link is a gate people start ignoring.
const L = '(?<![A-Za-z0-9_-])'

const PATTERNS = [
  ['aws-access-key', new RegExp(`${L}AKIA[0-9A-Z]{16}(?![A-Za-z0-9])`, 'g')],
  ['google-api-key', new RegExp(`${L}AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`, 'g')],
  ['slack-webhook', new RegExp(`${L}hooks\\.slack\\.com/services/T[A-Za-z0-9]+/B[A-Za-z0-9]+/[A-Za-z0-9]+`, 'g')],
  ['slack-token', new RegExp(`${L}xox[baprs]-[A-Za-z0-9-]{10,}`, 'g')],
  // anthropic before openai: `sk-ant-…` satisfies both, and the specific name is
  // the useful one in the report.
  ['anthropic-key', new RegExp(`${L}sk-ant-[A-Za-z0-9_-]{20,}`, 'g')],
  ['openai-key', new RegExp(`${L}sk-[A-Za-z0-9_-]{32,}`, 'g')],
  ['github-token', new RegExp(`${L}gh[pousr]_[A-Za-z0-9]{36}(?![A-Za-z0-9])`, 'g')],
  ['stripe-live-key', new RegExp(`${L}sk_live_[A-Za-z0-9]{16,}`, 'g')],
  ['private-key-pem', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['gcp-service-account', /"private_key_id"|"client_email"\s*:\s*"[^"]+\.iam\.gserviceaccount\.com"/g], // verify:allow-secret — a matcher, not a credential
  [
    'generic-assignment',
    /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]([^'"\s]{12,})['"]/gi,
    { value: 1, allowPlaceholder: true },
  ],
]

const mask = (s) => `${s.slice(0, 4)}…(${s.length})`

// --- git ---------------------------------------------------------------------
// Every call runs from the TOPLEVEL and is narrowed with a pathspec, because the
// two families disagree otherwise: `git diff` is repo-wide with toplevel-relative
// paths no matter where it is invoked, while `git ls-files` is scoped to the cwd
// and prints cwd-relative paths. Mixing them under a subdirectory --root gave a
// scan that reported files outside the root and numbered them against the wrong
// base. One base (toplevel), one scope (the pathspec).
// core.quotepath=false keeps non-ASCII paths literal instead of octal-escaped.
function gitAt(dir, args) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', '-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

const toplevelRaw = gitAt(root, ['rev-parse', '--show-toplevel'])
if (toplevelRaw === null) {
  // A FAIL, not a bare error: "we could not look" must never read as "nothing found".
  emit({ verdict: 'FAIL', reason: 'not-a-git-repo', root })
  process.exit(2)
}
const toplevel = toplevelRaw.trim()
// '.' means the scan root IS the toplevel, so no pathspec is needed.
const scopeRel = path.relative(toplevel, root) || '.'
const scope = scopeRel === '.' ? [] : ['--', scopeRel]
const git = (args) => gitAt(toplevel, [...args, ...scope])

// git quotes a path with specials in diff headers ("\346\274\242.js"). Undo it,
// bytes-first, so the name we print is the name that opens.
function unquotePath(p) {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const body = p.slice(1, -1)
  const bytes = []
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      bytes.push(...Buffer.from(body[i], 'utf8'))
      continue
    }
    const n = body[++i]
    if (n >= '0' && n <= '7') {
      bytes.push(parseInt(body.slice(i, i + 3), 8))
      i += 2
    } else {
      bytes.push(...Buffer.from({ n: '\n', t: '\t', r: '\r' }[n] ?? n, 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

// --- a. secrets --------------------------------------------------------------
const secrets = []
const seen = new Set()
const filesScanned = new Set()
let linesScanned = 0

function scanLine(file, line, content) {
  // The escape hatch, checked before any pattern: an intentional sample stays a
  // sample, and the reader never has to re-triage it.
  if (content.includes('verify:allow-secret')) return
  linesScanned++
  filesScanned.add(file)
  for (const [name, re, opts] of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(content)) !== null) {
      const value = opts?.value ? m[opts.value] : m[0]
      if (opts?.allowPlaceholder && (PLACEHOLDER.test(value) || MASK_FILLER.test(value))) continue
      const key = `${file}:${line}:${m[0]}`
      if (seen.has(key)) continue
      seen.add(key)
      secrets.push({ file, line, pattern: name, masked: mask(m[0]) })
    }
  }
}

// Walk a unified diff and hand back only the added lines, numbered on the NEW
// side — so a finding points at the line the reviewer will actually open.
function scanDiff(text) {
  if (!text) return
  let file = null
  let lineNo = 0
  let skip = true
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null
      skip = true
      continue
    }
    if (raw.startsWith('+++ ')) {
      const p = unquotePath(raw.slice(4).trim())
      // strip the b/ prefix AFTER unquoting — it sits inside the quotes
      file = p === '/dev/null' ? null : p.replace(/^b\//, '')
      skip = !file || SKIP_PATH.test(file)
      continue
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
      lineNo = m ? parseInt(m[1], 10) : 0
      continue
    }
    if (!file || skip) continue
    if (raw.startsWith('+')) {
      scanLine(file, lineNo, raw.slice(1))
      lineNo++
    } else if (raw.startsWith(' ')) {
      lineNo++
    }
    // '-' (removed) and '\' (no newline marker) carry no new-side line number
  }
}

scanDiff(git(['diff', '--no-color', '--no-ext-diff', '-U0']))
scanDiff(git(['diff', '--cached', '--no-color', '--no-ext-diff', '-U0']))

// Untracked and not ignored: the file that has not been added yet is exactly
// where a dumped credentials JSON sits before someone runs `git add -A`.
for (const rel of (git(['ls-files', '--others', '--exclude-standard', '-z']) || '')
  .split('\0')
  .filter(Boolean)) {
  if (SKIP_PATH.test(rel)) continue
  const abs = path.join(toplevel, rel)
  let buf
  try {
    if (statSync(abs).size > MAX_BYTES) continue
    buf = readFileSync(abs)
  } catch {
    continue
  }
  if (buf.includes(0)) continue // NUL byte ⇒ binary
  const lines = buf.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i++) scanLine(rel, i + 1, lines[i])
}

// --- b. tracked env files ----------------------------------------------------
const tracked = (git(['ls-files', '-z']) || '').split('\0').filter(Boolean)

const ENV_FILE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/
const envTracked = tracked.filter((f) => ENV_FILE.test(f) && !ENV_TEMPLATE.test(f))

// --- c. dependency audit -----------------------------------------------------
// The audit runs per PACKAGE, not per repo. The git toplevel is very often not
// the npm project root — a repo that keeps one site per client has a lockfile in
// each of them and none at the top — and a root-only audit there covers nothing
// while still printing a number, which is the silent green this gate refuses.
// So: audit the scan root when it owns a lockfile, otherwise audit every tracked
// package in the repo and say which one each finding came from.
const MAX_AUDIT_PACKAGES = 30
// yarn is discovered even though it is never audited: a yarn-only repo that
// vanished from discovery would report "no lockfile", which reads as clean when
// the truth is "one package, deliberately not audited". It surfaces as a named
// skip inside `packages` instead.
const DISCOVERABLE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/

const skipAudit = (reason) => ({ status: 'skip', high: 0, critical: 0, packages: [], reason })

function severityCounts(data) {
  const v = data?.metadata?.vulnerabilities
  if (v && typeof v === 'object') {
    return { high: Number(v.high) || 0, critical: Number(v.critical) || 0 }
  }
  // older pnpm reports per-advisory instead of a rollup
  const adv = data?.advisories
  if (adv && typeof adv === 'object') {
    let high = 0
    let critical = 0
    for (const a of Object.values(adv)) {
      if (a?.severity === 'high') high++
      else if (a?.severity === 'critical') critical++
    }
    return { high, critical }
  }
  return null
}

// Audit one package directory. `label` is how the package is named in the
// report — its path relative to the scan root — so a finding can be traced back
// to the package that owns it instead of arriving as a bare repo-wide number.
// yarn v1 streams line-delimited JSON: one `auditAdvisory` record per finding and
// a closing `auditSummary`. Berry's `yarn npm audit` is a different shape, so an
// unparseable body stays a NAMED skip rather than a fabricated zero.
function yarnAudit(dir, label) {
  const fail = (reason) => ({ dir: label, status: 'skip', high: 0, critical: 0, reason })
  const r = spawnSync('yarn', ['audit', '--json', '--groups', 'dependencies'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: AUDIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.signal === 'SIGTERM') return fail(`yarn audit timed out (${AUDIT_TIMEOUT_MS / 1000}s)`)
  if (r.error) return fail(`yarn audit could not run: ${r.error.code || r.error.message}`)

  let high = 0
  let critical = 0
  let summary = null
  let sawRecord = false
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec?.type === 'auditAdvisory') {
      sawRecord = true
      const sev = rec?.data?.advisory?.severity
      if (sev === 'high') high++
      else if (sev === 'critical') critical++
    } else if (rec?.type === 'auditSummary') {
      sawRecord = true
      summary = rec?.data?.vulnerabilities || null
    }
  }
  if (!sawRecord) {
    const err = `${r.stdout}\n${r.stderr}`
    if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|network|offline/i.test(err)) {
      return fail('yarn audit offline')
    }
    return fail('yarn audit produced no v1 records (berry or unknown format)')
  }
  // the summary is authoritative when present; the per-advisory tally is the fallback
  if (summary) {
    high = Number(summary.high) || 0
    critical = Number(summary.critical) || 0
  }
  return { dir: label, status: 'ok', high, critical }
}

function auditOne(dir, label) {
  const hasNpm = existsSync(path.join(dir, 'package-lock.json'))
  const hasPnpm = existsSync(path.join(dir, 'pnpm-lock.yaml'))
  const fail = (reason) => ({ dir: label, status: 'skip', high: 0, critical: 0, reason })
  if (!hasNpm && !hasPnpm && existsSync(path.join(dir, 'yarn.lock'))) {
    return yarnAudit(dir, label)
  }
  if (!hasNpm && !hasPnpm) return fail('no lockfile')
  const [bin, args] = hasNpm
    ? ['npm', ['audit', '--omit=dev', '--audit-level=high', '--json']]
    : ['pnpm', ['audit', '--prod', '--json']]
  const r = spawnSync(bin, args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: AUDIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.signal === 'SIGTERM') return fail(`${bin} audit timed out (${AUDIT_TIMEOUT_MS / 1000}s)`)
  if (r.error) return fail(`${bin} audit could not run: ${r.error.code || r.error.message}`)

  // A non-zero exit is how these clients report "vulnerabilities found", so the
  // status is read from the JSON body, never from the exit code.
  let data = null
  try {
    data = JSON.parse(r.stdout)
  } catch {
    const err = `${r.stdout}\n${r.stderr}`
    return fail(
      /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|network|offline/i.test(err)
        ? `${bin} audit offline`
        : `${bin} audit output was not JSON`
    )
  }
  if (data?.error) return fail(`${bin} audit error: ${data.error.code || data.error.summary || 'unknown'}`)
  const counts = severityCounts(data)
  if (!counts) return fail(`${bin} audit JSON had no vulnerability summary`)
  return { dir: label, status: 'ok', high: counts.high, critical: counts.critical }
}

function runAudit() {
  if (!wantAudit) return skipAudit('--no-audit')

  const rootHasLock = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((f) =>
    existsSync(path.join(root, f))
  )
  let dirs
  let overflow = []
  if (rootHasLock) {
    // labels stay toplevel-relative like every other path in the report
    dirs = [scopeRel]
  } else {
    const found = [
      ...new Set(
        tracked
          .filter((f) => DISCOVERABLE.test(f) && !/(^|\/)node_modules\//.test(f))
          .map((f) => path.dirname(f))
      ),
    ].sort()
    if (!found.length) return skipAudit('no lockfile')
    dirs = found.slice(0, MAX_AUDIT_PACKAGES)
    overflow = found.slice(MAX_AUDIT_PACKAGES)
  }

  const packages = dirs.map((d) => auditOne(path.resolve(toplevel, d), d))
  const done = packages.filter((p) => p.status === 'ok')
  const missed = packages.filter((p) => p.status !== 'ok')
  const high = done.reduce((n, p) => n + p.high, 0)
  const critical = done.reduce((n, p) => n + p.critical, 0)

  // Coverage that is not total has to say so: a package that never got audited
  // must not hide inside a sum that looks complete.
  const notes = []
  if (missed.length) notes.push(missed.map((p) => `${p.dir}: ${p.reason}`).join('; '))
  if (overflow.length) {
    notes.push(`${overflow.length} more package(s) over the cap of ${MAX_AUDIT_PACKAGES}, not audited: ${overflow.join(', ')}`)
  }

  const out = {
    status: missed.length || overflow.length ? 'partial' : 'ok',
    high,
    critical,
    packages,
  }
  if (notes.length) out.reason = notes.join(' · ')
  return out
}

const audit = runAudit()

// --- verdict -----------------------------------------------------------------
// `partial` still blocks on what it DID find: incomplete coverage is a reason to
// distrust a zero, never a reason to ignore a real count.
const auditBlocking = audit.status !== 'skip' && audit.high + audit.critical > 0
const verdict = secrets.length || envTracked.length || auditBlocking ? 'FAIL' : 'PASS'

emit({
  secrets,
  envTracked,
  audit,
  verdict,
  scanned: { files: filesScanned.size, lines: linesScanned },
})
process.exit(verdict === 'PASS' ? 0 : 1)

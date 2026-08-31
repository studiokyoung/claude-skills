#!/usr/bin/env node
// Multi-viewport screenshot capture for the /verify skill.
//
// Captures VIEWPORT-SIZED tiles (never full-page) of the given routes at
// mobile / tablet / desktop, driving a real scroll pass first so reveal/lazy
// content fires and below-the-fold breakage (the mobile-carousel class of bug
// that shipped because only desktop 1440x900 was ever screenshotted) is seen.
//
// Usage:
//   node shoot.mjs --root <projectRoot> --out <dir> [--routes /,/work/x]
//                  [--base http://localhost:3000] [--port 3000]
//                  [--start "yarn dev"] [--no-serve] [--wait 90]
//
// Resolves playwright from <projectRoot>'s node_modules first (falls back to the
// script's own). If nothing is serving <base> and serving is allowed, it starts
// the project's dev server, waits, captures, then kills ONLY a server it started
// (a server already running is reused and left alone).
//
// Prints one JSON object as the last stdout line:
//   {"ok":bool,"served":bool,"base":str,"outDir":str,"count":n,"tiles":[...]}
// Exit codes: 0 ok · 2 playwright missing · 3 server not ready · 4 no tiles.

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const VIEWPORTS = [
  ['mobile', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1440, 900],
]

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}
function flag(name) {
  return process.argv.includes(`--${name}`)
}

const root = path.resolve(arg('root', process.cwd()))
const outDir = path.resolve(arg('out', path.join('/tmp', 'verify-shots-' + path.basename(process.cwd()))))
const routes = arg('routes', '/')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
const port = arg('port', '3000')
const base = arg('base', `http://localhost:${port}`).replace(/\/$/, '')
const waitSec = parseInt(arg('wait', '90'), 10)
const canServe = !flag('no-serve')

function emit(obj) {
  console.log(JSON.stringify(obj))
}

// --- resolve playwright: the target project first, then this script's own ---
// playwright's entry is CommonJS, so a dynamic import lands the exports under
// `.default` — take chromium from either shape.
function pickChromium(mod) {
  return mod?.chromium ?? mod?.default?.chromium
}
let chromium
try {
  const req = createRequire(path.join(root, 'noop.js'))
  chromium = pickChromium(await import(pathToFileURL(req.resolve('playwright'))))
} catch {
  try {
    chromium = pickChromium(await import('playwright'))
  } catch {
    /* handled below */
  }
}
if (!chromium) {
  emit({ ok: false, reason: 'playwright-missing', root })
  process.exit(2)
}

async function up() {
  try {
    const r = await fetch(base + '/', { signal: AbortSignal.timeout(1500) })
    return r.status < 500
  } catch {
    return false
  }
}

function detectStart() {
  const explicit = arg('start', '')
  if (explicit) return explicit
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm dev'
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn dev'
  return 'npm run dev'
}

// --- ensure a server, starting the project's dev server if we must ---
let serverChild = null
let served = false
function killServer() {
  if (serverChild) {
    try {
      serverChild.kill('SIGTERM')
    } catch {}
    serverChild = null
  }
}
process.on('exit', killServer)
process.on('SIGINT', () => {
  killServer()
  process.exit(130)
})
process.on('SIGTERM', () => {
  killServer()
  process.exit(143)
})

if (!(await up())) {
  if (!canServe) {
    emit({ ok: false, reason: 'server-down-no-serve', base })
    process.exit(3)
  }
  const cmd = detectStart()
  const [bin, ...rest] = cmd.split(' ')
  let spawnErr = null
  serverChild = spawn(bin, rest, {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, BROWSER: 'none' },
  })
  serverChild.on('error', (e) => {
    spawnErr = e.message
  })
  const deadline = Date.now() + waitSec * 1000
  while (Date.now() < deadline && !spawnErr) {
    if (await up()) {
      served = true
      break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!served) {
    killServer()
    emit({ ok: false, reason: 'server-not-ready', base, cmd, spawnErr, waited: waitSec })
    process.exit(3)
  }
}

// --- capture ---
function routeName(r) {
  const n = r === '/' ? 'home' : r.replace(/^\//, '').replace(/\//g, '_')
  return n || 'home'
}

await mkdir(outDir, { recursive: true })
const browser = await chromium.launch()
const tiles = []
const problems = []

for (const [label, w, h] of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  for (const route of routes) {
    const errors = []
    const onErr = (e) => errors.push(`pageerror: ${e.message}`)
    const onCon = (m) => m.type() === 'error' && errors.push(`console: ${m.text().slice(0, 160)}`)
    page.on('pageerror', onErr)
    page.on('console', onCon)
    let loadErr = null
    try {
      await page.goto(base + route, { waitUntil: 'load', timeout: 45000 })
      await page.waitForTimeout(1500)
      // warm-up scroll pass so reveals / lazy media fire, then measure height
      const scrollH = await page.evaluate(async () => {
        const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
        const H = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
        const total = H()
        for (let y = 0; y <= total; y += Math.round(window.innerHeight * 0.9)) {
          window.scrollTo(0, y)
          await raf()
        }
        window.scrollTo(0, 0)
        await raf()
        return H()
      })
      await page.waitForTimeout(600)
      // tile positions: top always; add mid/bottom when the page is tall so the
      // below-the-fold region gets its own viewport tile (never one long shot).
      const positions = [['top', 0]]
      if (scrollH > h * 1.5) positions.push(['mid', Math.max(0, Math.round(scrollH / 2 - h / 2))])
      if (scrollH > h * 2.2) positions.push(['bottom', Math.max(0, scrollH - h)])
      for (const [pos, y] of positions) {
        await page.evaluate((yy) => window.scrollTo(0, yy), y)
        await page.waitForTimeout(400)
        const file = path.join(outDir, `${label}-${routeName(route)}-${pos}.png`)
        await page.screenshot({ path: file }) // viewport tile — NOT fullPage
        tiles.push({ label, viewport: `${w}x${h}`, route, pos, path: file })
      }
    } catch (e) {
      loadErr = e.message
    }
    const clean = errors
      .filter((e) => !/favicon|404|net::|Failed to load resource|ERR_/.test(e))
      .slice(0, 3)
    if (loadErr || clean.length) {
      problems.push({ label, viewport: `${w}x${h}`, route, loadErr, errors: clean })
    }
    page.off('pageerror', onErr)
    page.off('console', onCon)
  }
  await ctx.close()
}
await browser.close()
killServer()

emit({
  ok: tiles.length > 0,
  served,
  base,
  outDir,
  count: tiles.length,
  routes,
  viewports: VIEWPORTS.map(([l, w, h]) => `${l} ${w}x${h}`),
  tiles,
  problems,
})
process.exit(tiles.length > 0 ? 0 : 4)

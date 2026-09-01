---
name: verify
description: Runs Kyoung's full pre-commit / pre-handoff verification gate in one command and prints an honest PASS/FAIL table. Use before committing, before handing work off, or when he says "verify", "check it", "is this safe to ship", "run the gate", and right after a change lands. Detects the stack and runs each applicable gate — git state, TypeScript typecheck, jest/vitest tests, and MULTI-VIEWPORT screenshots (mobile 390, tablet 768, desktop 1440 as viewport tiles, never a full-page shot) so below-the-fold and mobile-only breakage can't slip through. On a mobile app (Expo/React Native), the UI gate is the repo's MAESTRO flows on a booted simulator/device instead of browser screenshots. Skips a gate only with a stated reason and never reports "verified" when a step did not actually run. Not a diff-quality review (use /explain-diff) or a correctness bug hunt (use /code-review).
user-invocable: true
argument-hint: "[routes to shoot, e.g. / /work/corppay-app] [no-serve]"
metadata:
  version: "1.2.0"
allowed-tools:
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(cat:*)
  - Bash(ls:*)
  - Bash(test:*)
  - Bash(node:*)
  - Bash(npx tsc:*)
  - Bash(npx jest:*)
  - Bash(npx vitest:*)
  - Bash(npm run:*)
  - Bash(npm test:*)
  - Bash(npm exec:*)
  - Bash(yarn:*)
  - Bash(pnpm:*)
  - Bash(curl:*)
  - Bash(maestro:*)
  - Bash(xcrun:*)
  - Bash(adb:*)
  - Bash(mkdir:*)
  - Bash(open:*)
  - Read
  - Grep
  - Glob
  - Write(//tmp/**)
  - Write(//private/tmp/**)
---

# verification gate (verify)

Kyoung's pre-commit / pre-handoff ritual, run as one keystroke and non-optional.
The ritual (git state → typecheck → tests → multi-viewport screenshots) works
every time it is actually done; it fails only when a step gets skipped. This
skill runs every applicable step and prints one PASS/FAIL table so the decision
to commit or hand off takes a single read.

**The prime directive: honesty over green.** Never print ✅PASS, or say
"verified", for a step whose command did not actually run and come back clean.
A gate that reports success it did not observe is worse than no gate. When a
step cannot run, it is ⏭️SKIP with the reason, or ❌FAIL — never a silent pass.

Boundaries with the neighbouring tools:
- `/explain-diff` = does this change **deserve to exist** (diff-quality review).
- `/code-review` = is this change **wrong** (exhaustive correctness bugs).
- This skill = **did the gate actually pass** before you commit or hand off.

Write the table and prose in the language Kyoung is prompting in.

## 1. Detect the stack (before running anything)

From the repo root, establish what applies. Cheap checks, no guessing:

- **Package + scripts:** read `package.json` if present — note `scripts`
  (`typecheck`, `test`, `dev`, `build`) and `dependencies`/`devDependencies`.
- **Package manager:** `pnpm-lock.yaml` → pnpm; `yarn.lock` → yarn; else npm.
  Use it for every script call below (`yarn typecheck`, `pnpm test`, …).
- **TypeScript:** a `tsconfig.json` at root (or a `typecheck` script) means the
  typecheck gate applies.
- **Tests:** `jest` or `vitest` in deps/devDeps, or a `test` script, means the
  test gate applies.
- **Web UI:** `next` / `vite` / `astro` / `react-scripts` in deps, or a `dev`
  script, or a `playwright` dep, means the screenshot gate applies.
- **Mobile app:** `expo` or `react-native` in deps means this is an app, and it
  **never takes the screenshot gate** (an `expo start` dev script is not a web
  UI; browser viewport tiles mean nothing on a phone). Its UI gate is
  **maestro**: a `.maestro/` (or `maestro/`) directory with flows means the
  maestro gate applies. An app with no flows gets ⏭️SKIP "no maestro flows" on
  that row — and say loudly that the app shipped with no UI gate at all.

A gate whose signal is absent is ⏭️SKIP with that reason (e.g. "no tsconfig",
"no web UI") — not a failure. A gate whose signal is present **must run**.

## 2. Run the gates

Run each applicable gate and capture the real result. Give each a hard timeout
so nothing hangs the session (a test in watch mode is the classic trap).

### Git state — always
```
git status --short
git log --oneline -3
```
Report what is uncommitted (or "clean") and the recent history. This gate is
informational: it is ✅ when it ran. Note loudly if the tree is **clean** but
you were asked to verify a change — there may be nothing staged to verify.

### Typecheck — when TypeScript is present
Prefer the project's script; fall back to the compiler:
```
<pm> run typecheck        # if a typecheck script exists
npx tsc --noEmit          # otherwise, when tsconfig.json exists
```
✅PASS only on exit 0. On failure, ❌FAIL with the **first few** error lines
(file:line), not the whole dump.

### Tests — when jest/vitest is present
Run once, never in watch mode:
```
<pm> test -- --ci --watchAll=false     # jest
npx vitest run                         # vitest
<pm> test                              # a test script, if it already runs once
```
✅PASS only on exit 0. On failure, ❌FAIL with the failing-suite summary line(s).
If a `test` script exists but you cannot tell it is non-watch, pass the runner's
run-once flag explicitly rather than risk a hang.

### Multi-viewport screenshots — when there is a web UI
This is the gate that the desktop-only habit skips, and it is where the
mobile-only breakage hides. Capture the target screens at **390×844 (mobile),
768×1024 (tablet), 1440×900 (desktop)** as **viewport-sized tiles — never a
full-page shot** (a 37000px full-page image is useless and is what shipped the
bug this rule exists for). The reference script does exactly this and reuses the
project's own playwright + dev server.

1. Pick a fresh temp dir: `mkdir -p /tmp/verify-<repo>-$(date +%Y%m%d-%H%M%S)`.
2. Choose routes: the screens the change touched. Map changed files from
   `git status --short` to their routes when you can; otherwise default to `/`.
   Routes given in the arguments override this. Pass them space- or
   comma-separated.
3. Run the capture (it prints one JSON object as its last stdout line):
   ```
   node <skill dir>/references/shoot.mjs \
     --root <projectRoot> --out <tempDir> --routes /,/work/x --port 3000
   ```
   - If a dev server is already running it is reused and left alone; if not, the
     script starts the project's dev server, waits, captures, then kills only
     the server it started. Pass `--no-serve` (from the `no-serve` argument) to
     forbid starting one — then it is ⏭️SKIP "no server, no-serve" if nothing is
     up. Pass `--start "<cmd>"` / `--port <n>` / `--base <url>` to override.
   - The script emits up to three tiles per viewport per route (top, plus
     mid/bottom when the page is tall) so below-the-fold is its own tile.
4. Parse the JSON: `count` tiles written, `tiles[].path`, and any `problems`
   (page errors / failed loads). This gate is ✅ = **tiles captured** (it does
   NOT mean they look right — a human still eyeballs them). Report every path so
   Kyoung can open them, and surface `problems` loudly. `"reason"` fields mean
   a skip/fail: `playwright-missing` → ⏭️SKIP "no playwright in project";
   `server-not-ready` / `server-down-no-serve` → ❌FAIL or ⏭️SKIP with the reason.

### Mobile E2E screenshots (Maestro) — when the repo is React Native/Expo with `.maestro/`
Native apps have no web-UI gate; their real-verification equivalent is a
**Maestro screenshot smoke on the iOS simulator**. Signals: `react-native` or
`expo` in deps AND a `.maestro/` directory — both present means this gate
**must run** (the web screenshot row stays ⏭️ "no web UI"). Preconditions,
each a named ⏭️SKIP reason when missing: the `maestro` binary
(`~/.maestro/bin/maestro`), a **booted** simulator with the dev build
(`xcrun simctl list devices booted`), Metro serving the branch
(`lsof -iTCP:8081 -sTCP:LISTEN`).

```
JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH="$HOME/.maestro/bin:$PATH" \
  maestro test .maestro/staging/<probe>.yaml
```

- The probe flow lives in `.maestro/staging/` and screenshots the screens the
  change touched into `/tmp/verify-<repo>-<ts>/`. In corp-mobile,
  `97-probe-template.yaml` is the template; runtime gotchas live in
  `.maestro/README.md`. Traps a probe must survive (all baked in the template):
  - a cold dev-client launch lands on the DEVELOPMENT SERVERS launcher —
    connect to the Metro row first;
  - a system "Open in <App>?" alert **occludes the whole hierarchy** for
    Maestro — clear a stale one at start, handle it after every `openLink`;
  - RN ScrollViews keep below-the-fold rows in the hierarchy with off-clip
    coordinates, so a tap can "complete" against nothing — use
    `scrollUntilVisible` with `centerElement: true`, then **gate on the
    outcome** (e.g. `notVisible` of the sheet) before asserting the
    destination; never trust the tap alone.
- ✅PASS = every flow assert passed AND the screenshots exist on disk. Report
  every path; a human still eyeballs them. ❌FAIL = a flow assert failed —
  that is the gate catching something; the debug screenshot in
  `~/.maestro/tests/<timestamp>/` shows what the sim actually displayed.
- The probe drives the shared dev simulator: it reuses the logged-in session
  and resets nothing beyond what the app's dev tools stage in their store.

### Maestro flows — when the repo is a mobile app with `.maestro/` flows

The app equivalent of the screenshot gate, promoted from the first field run
(corp-mobile, 2026-09-01): a maestro flow drives the real UI on a real
simulator and fails on what a static shot cannot see.

1. Find the flows: `.maestro/config.yaml` plus `flows/` (and `subflows/`).
   Choose the flows covering the screens the change touched (map changed files
   to flows by name/route); when the mapping is unclear and the set is small,
   run them all. Flow names given in the arguments override this.
2. Preconditions, checked honestly, each its own reason:
   - `maestro` CLI on PATH — missing → ⏭️SKIP "maestro not installed";
   - a booted simulator/emulator or device (`xcrun simctl list devices booted`
     / `adb devices`) — none → ⏭️SKIP "no booted device";
   - a dev-client build needs Metro attached BEFORE the flow launches the app —
     without it the launch fails, not the flow (field trap): start/attach the
     dev server first, or mark ❌ with that reason, never blame the flow.
3. Run `maestro test <flow>` per chosen flow, each with a hard timeout.
   ✅PASS only when every chosen flow exits 0. On failure, ❌FAIL with the flow
   name, the first failing step, and maestro's own screenshot/log path if it
   wrote one.
4. Known traps from the field run — encode, don't rediscover:
   - dismiss stale system alerts first; a leftover permission dialog occludes
     the hierarchy and fails unrelated assertions;
   - a tap on ScrollView content outside the clip "completes" against nothing —
     scroll it into view (centerElement) and gate on visibility before tapping;
   - `tapOn` by a glyph that also appears in an amount display is ambiguous —
     tap stable testIDs/chips, not rendered digits.
5. The row's detail names the flows run and the device. Like screenshots, ✅
   means the flows passed; everything maestro caught goes into `caught` in §4's
   record, and the `gates` map carries it as `"maestro"`.

## 3. The PASS/FAIL table

One row per gate. Lead with a loud banner **only when** something applicable
FAILED, or a gate that should have run was skipped. Then the table, then the
screenshot paths.

````markdown
❌ NOT VERIFIED — <what failed / what was skipped that should not have been>
(omit this line entirely when every applicable gate passed)

| gate | status | detail |
|------|--------|--------|
| git state | ✅PASS | 3 files uncommitted · last: `a163b5f T35 …` |
| typecheck | ✅PASS | `tsc --noEmit` clean |
| tests | ❌FAIL | 1 suite failed: `carousel.test.ts` |
| screenshots | ✅PASS | 9 tiles (3 vp × home,work) → /tmp/verify-… · eyeball them |

Screenshots (open these):
- /tmp/verify-…/mobile-home-top.png
- …

Verdict: <one line — e.g. "typecheck + shots pass, but tests FAIL: not safe to commit">
````

Rules:
- Status is exactly one of ✅PASS / ❌FAIL / ⏭️SKIP. A skip always carries its
  why in the detail cell.
- The screenshots row is ✅ when tiles were written; its detail says the human
  must look. Never phrase it as "looks correct" — the skill did not judge that.
- On a mobile app the screenshots row is replaced by a `maestro` row (flows
  run · device); the same ✅-only-on-exit-0 rule applies, and a skipped
  precondition is ⏭️ with its reason, never a silent pass.
- End with a one-line verdict: is it safe to commit / hand off, or not. If any
  applicable gate is ❌ or a should-run gate was ⏭️, the verdict is "not safe".
- Offer to `open <tempDir>` so the tiles come up for review.

## 4. Mark the tree and record the run (always, last)

Two commands after the table is final. They are what the skill router and the run
ledger see; skipping them is the same failure as printing a ✅ you did not earn.

1. **Marker — only when the verdict is *safe*** (every applicable gate ✅PASS, no
   should-run gate ⏭️SKIP):
   ```
   node <skill dir>/references/mark-pass.mjs --root <projectRoot> \
     --gates '{"git":"PASS","typecheck":"PASS","tests":"PASS","screenshots":"PASS"}' \
     --routes '["/","/work/x"]'
   ```
   `--routes` here is a JSON array (`'["/","/work/x"]'`), not the comma list `shoot.mjs`
   takes; if the command prints `bad-routes-json`, no marker was written — fix the
   argument and rerun it.

   The command writes `.git/verify-pass` with a fingerprint of the exact tree you
   verified. The
   router's commit gate (web repos) accepts `git commit` only while the tree still
   matches; one more edit means one more `/verify`. When the verdict is *not safe*,
   clear any stale marker instead:
   `node <skill dir>/references/mark-pass.mjs --root <projectRoot> --clear`
2. **Run record — always, safe or not:**
   ```
   node <skill dir>/references/record-run.mjs --skill verify --cwd <projectRoot> --json \
     '{"verdict":"safe","gates":{"git":"PASS","typecheck":"PASS","tests":"PASS","screenshots":"PASS"},"tiles":9,"routes":["/","/work/x"],"duration_s":84,"caught":[]}'
   ```
   The same command when a gate failed — the verdict flips with it:
   ```
   node <skill dir>/references/record-run.mjs --skill verify --cwd <projectRoot> --json \
     '{"verdict":"not-safe","gates":{"git":"PASS","typecheck":"PASS","tests":"FAIL","screenshots":"PASS"},"tiles":9,"routes":["/","/work/x"],"duration_s":61,"caught":["tests: carousel.test.ts failed"]}'
   ```
   Use the table's real values. `verdict` follows §3's rule exactly: `safe` only when
   every applicable gate is ✅PASS and no should-run gate was ⏭️SKIP — anything else is
   `not-safe`. `gates` values are `PASS` / `FAIL` / `SKIP`, and the map carries every gate the
   stack actually ran (a mobile app adds `"maestro"`); `caught` lists what the gate
   actually stopped (a failing suite, a typecheck error, a page error in the tiles) and
   is `[]` when everything passed. The record is one appended line in
   `$SKILL_RUNS_DIR/verify.jsonl` (default `~/.claude/skill-runs/`); it never touches
   the repo.

Both commands print one JSON line; if either prints `"ok": false`, say so under the
table (the gate result still stands; the bookkeeping did not).

## Verification (self-check before you report — mandatory)

Before you report, confirm each — if any answer is no, fix the table,
do not soften it:

- Did every gate the stack detection marked **applicable** actually execute? A
  detected-but-not-run gate is ❌/⏭️ with the reason, never ✅.
- Is every ✅PASS backed by a command that returned exit 0 (or, for screenshots,
  tiles that exist on disk)? No ✅ from assumption.
- Does every ⏭️SKIP name a concrete reason (no tsconfig, no web UI, no-serve)?
- Are the screenshots real **viewport tiles** at the three sizes (the JSON
  `viewports` line confirms 390/768/1440), not one long full-page image?
- On a mobile app: did maestro actually drive the chosen flows on a booted
  device (flow names + device in the detail), with missing preconditions
  reported as ⏭️/❌ and their reasons — never a ✅ from assumption?
- RN/Expo repo with `.maestro/`: did the Maestro gate actually run (flow asserts
  passed, screenshot files exist), or is it a named ⏭️SKIP? "Native app" alone
  is a reason to run this gate, never to skip real verification.
- If anything failed or was wrongly skipped, does the top banner say so before
  the table — no burying it in a cell?
- Did `mark-pass.mjs` (or `--clear`) and `record-run.mjs` both run after the table? The
  report is not finished until they did.

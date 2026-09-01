---
name: skill-router
description: Operator console for the skill router — the hooks that gate web-repo commits behind /verify, remind about reuse-scout and save-memory, and record every skill run. Use for "/skill-router", "is the router on", "why didn't the reminder fire", "why was my commit denied", "the verify gate is blocking me", "add a repo to the gate", "turn the router off / back on", "show me the router log / the run records". Reports only what a command in this run actually printed — what is installed, whether this repo is gated, what the log decided, what the records hold — and installs or uninstalls after an explicit yes. Not the gate itself (that is /verify), not a diff review (/explain-diff), not a bug hunt (/code-review).
user-invocable: true
argument-hint: "[status|log [n]|rules|records [skill]|why-denied|install|uninstall|doc]"
metadata:
  version: "1.0.0"
allowed-tools:
  - Bash(node /Users/kyounghoonkim/claude-skills/router/install.mjs --dry-run:*)
  - Bash(node ~/claude-skills/router/install.mjs --dry-run:*)
  - Bash(tail:*)
  - Bash(cat:*)
  - Bash(ls:*)
  - Bash(grep:*)
  - Bash(wc:*)
  - Bash(git rev-parse:*)
  - Bash(git -C:*)
  - Bash(node -e:*)
  - Read
  - Grep
  - Glob
---

# skill router (operator console)

The router is three hooks, so it has no command of its own: it fires on prompts
and tool calls, denies a commit that has no passing `/verify` behind it, and
appends a line to a log nobody reads until something surprises them. This skill
is the human end of it — what is installed, what fired, what it decided, and how
to turn it on or off.

**The prime directive: read it, don't remember it.** Every line you report comes
from a command run in *this* turn. "Installed" comes from the installer's own
dry-run, "gated" from the rule file compared against this repo's real name,
"denied because X" from the log line itself. The router's whole value is being
an honest record; a status card built from memory of how it was last week
destroys that in one sentence.

Write the card and the prose in the language the user is prompting in. Keep
paths, rule ids, log lines, and JSON keys as they are.

## 1. Resolve the subcommand

The first word of the arguments picks the section. No arguments means `status`.

| argument | section |
|---|---|
| (none), `status`, `상태` | §2 |
| `log [n]` | §3 |
| `rules` | §4 |
| `records [skill]` | §5 |
| `why-denied`, `denied` | §6 |
| `install` / `uninstall` | §7 |
| `doc`, `docs`, `guide` | §8 |

Anything else: run §2 and add one line naming the valid subcommands. If the word
names a tracked skill (`verify`, `reuse-scout`, `save-memory`, `explain-diff`),
read it as `records <skill>` instead.

## 2. status

Six reads, then one card. Do all six before printing anything — a half-read card
is where the wrong claim gets made.

1. **What the settings file holds** (hook event names + scripts, the router's
   allow rules, the records dir):
   ```
   node -e 'const s=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8"));const H=s.hooks||{};console.log("hooks:",Object.entries(H).map(([e,v])=>e+" ["+v.flatMap(x=>(x.hooks||[]).map(h=>String(h.command).split("/").pop())).join(" ")+"]").join(" | ")||"(none)");console.log("allow:",(s.permissions&&s.permissions.allow||[]).filter(a=>/^Skill\(/.test(a)).join(" ")||"(none)");console.log("SKILL_RUNS_DIR:",(s.env||{}).SKILL_RUNS_DIR||"(unset)")'
   ```
   A missing settings file throws here; that is "not installed", report it as such.
2. **Is it actually installed** — ask the installer, which is the only answer that
   accounts for a moved checkout or a half-applied merge:
   ```
   node ~/claude-skills/router/install.mjs --dry-run
   ```
   `router: nothing to change` = installed, all three hooks + the allow rules +
   the env var. Any change list = **not installed, or partial**, and each line
   names exactly the missing piece (`hooks.PreToolUse: added pre-tool.mjs`).
   Never upgrade "the hooks are in the file" into "installed" without this.
3. **Which repos are gated:**
   ```
   node -e 'const r=JSON.parse(require("fs").readFileSync(process.env.HOME+"/claude-skills/router/skill-rules.json","utf8"));for(const [g,v] of Object.entries(r.repo_groups))console.log(g+": "+v.join(", "))'
   ```
4. **Is THIS repo gated** — the name is the basename of the repository root, taken
   from the common git dir so a linked worktree answers with its main checkout's
   name:
   ```
   git rev-parse --path-format=absolute --git-common-dir
   ```
   The repo name is the basename of that path's parent (the path itself ends in
   `.git`). Gated = that name appears in `repo_groups.web`. Outside a git repo,
   only `*` rules apply, so nothing is gated.
5. **The marker** — per worktree, in that worktree's own git dir:
   ```
   git rev-parse --path-format=absolute --git-dir
   cat <that path>/verify-pass
   ```
   Present means a `/verify` passed at its `ts`, over the tree as it was then. It
   is **not** a promise the next commit passes: the gate recomputes the
   fingerprint at commit time and any edit since moves it. Absent is normal (no
   verify yet in this worktree, or the last one verified not-safe and cleared it).
6. **The last five decisions:**
   ```
   tail -n 5 ~/.claude/router-state/router.log
   ```

Then one compact card, values filled from the six reads:

```
router: installed (3 hooks) · this repo: portfolio-html → GATED (repo_groups.web)
hooks    UserPromptSubmit on-prompt.mjs · PreToolUse pre-tool.mjs · PostToolUse post-skill.mjs
allow    Skill(verify) Skill(reuse-scout)
records  SKILL_RUNS_DIR=~/.claude/skill-runs
marker   .git/verify-pass · ts 2026-09-01T00:12:03-04:00
gated    portfolio-html, studio-kyoung, client-site-a, client-site-b, client-site-c
last 5   04:12  skill   Self-GraphDB   invoke  artifact-design model
         03:52  commit  Self-GraphDB   allow   out-of-scope
         …
```

Close with one line saying what it means here: gated and marked, gated and
unmarked (the next commit will be denied until `/verify` runs), or out of scope
(the gate never fires in this repo, reminders still can).

## 3. log [n]

```
tail -n 20 ~/.claude/router-state/router.log
```

`n` from the arguments, default 20. Print the lines, then the legend — do not
paraphrase a line into a verdict.

Six tab-separated columns: `ts · event · rule · repo · decision · why`. `ts` is
UTC ISO, `rule` is `-` when no rule was involved. The file rotates to
`router.log.1` at 1 MB, so an old decision may be one file over. An empty or
missing file means no hook has logged yet (a brand new install, or
`ROUTER_STATE_DIR` pointing elsewhere) — it does **not** mean the router is off.

| event | decisions you will see |
|---|---|
| `prompt` | `user-invoked` (you typed the slash command), `remind` (a rule fired) |
| `commit` | `allow` / `deny` from the verify gate |
| `new-file` | `remind` (context injected) or `deny-once` (first attempt denied, retry passes) |
| `skill` | `invoke` (a tracked skill ran), `skip`, `record-failed` |
| `rules` | `rules-load-failed` — the rule file did not parse, so everything was let through |

The `why` column on a `commit` line is a fixed vocabulary. The first five are
passes, the last three are the denials:

| why | meaning |
|---|---|
| `out-of-scope` | this repo is not in a `pre-commit` rule's group; the gate never applied |
| `override SKIP_VERIFY` | `SKIP_VERIFY=1` led the command; a deliberate, logged override |
| `nothing-to-commit` | the commit carried no paths the hook could see |
| `docs-only` | every path matched `docs_only` (`.md`, `.mdx`, `.txt`, `.markdown`) |
| `verified <ts>` | the marker's fingerprint still matches the live tree |
| `marker missing` | no `.git/verify-pass` in this worktree |
| `tree changed since <ts>` | there was a passing verify, then the tree moved |
| `fingerprint unavailable (git failed)` | the tree could not be hashed; the gate fails closed |

## 4. rules

Everything the router does is policy in one file, `router/skill-rules.json`; the
scripts are generic. Print it as a table:

```
node -e 'const r=JSON.parse(require("fs").readFileSync(process.env.HOME+"/claude-skills/router/skill-rules.json","utf8"));for(const x of r.rules)console.log([x.id,x.event,typeof x.repos==="string"?x.repos:x.repos.join("/"),x.mode,x.once_per_session?"once":"-",x.unless_ran||"-",String((x.patterns||x.paths||["-"])[0]).slice(0,40)].join(" | "))'
```

| id | event | repos | mode | once | unless_ran | first pattern |
|---|---|---|---|---|---|---|

Read the columns as: `event` is when it is checked (`prompt`, `pre-commit`,
`new-file`), `repos` is a group name / `*` / an explicit list, `mode` is `block`
(only valid for `pre-commit`) or `remind`, `once` means one reminder per session,
and `unless_ran` suppresses it once that skill has run in the session. The
pattern column is truncated for reading; quote the file, not this table, when the
exact regex matters.

**Add a repo to the gate:** append its directory name to `repo_groups.web` in
`~/claude-skills/router/skill-rules.json` (the `corp` group is the save-memory
reminder's scope). The name is the basename of the repo root, so a linked
worktree needs no separate entry.

**Add a rule:** one object in `rules`, plus a matching sentence and a near-miss
that must *not* match in `router/test/rules.test.mjs`. No script change.

Either way, run the suite once afterwards — quote the glob, Node 22 reads the
bare directory form as a module path:

```
cd ~/claude-skills && node --test 'router/test/*.test.mjs'
```

Rules are re-read by every hook process, so an edit applies to the very next tool
call with no restart. (Only `settings.json` changes, §7, need a new session.)

This skill reports the edit; it does not make it. Say which file, which key, and
which line to add, and let the change happen as a normal edit that the suite then
covers.

## 5. records [skill]

Run records live in `~/.claude/skill-runs/<skill>.jsonl` (or `$SKILL_RUNS_DIR`
from §2 if it was set to something else), one JSON object per line, never edited
in place.

With no skill named, list what exists:
```
wc -l ~/.claude/skill-runs/*.jsonl
```

With a skill named, the last few and the shape of the file:
```
tail -n 5 ~/.claude/skill-runs/<skill>.jsonl
grep -c '"type":"invoke"' ~/.claude/skill-runs/<skill>.jsonl
grep -c '"type":"run"' ~/.claude/skill-runs/<skill>.jsonl
grep -c '"type":"annotation"' ~/.claude/skill-runs/<skill>.jsonl
```
`grep -c` exits 1 when it counts zero. That is a zero, not a failure.

| type | what it means |
|---|---|
| `invoke` | a hook saw the skill start; `trigger` is `user` (you typed it), `router` (a reminder fired earlier) or `model` (it picked the skill itself) |
| `run` | the skill wrote its own outcome as its last step; the only place a `run` line comes from |
| `annotation` | appended later (by `debrief`), pointing at a run by `ref` — what that run missed |

Summarize the tail rather than dumping JSON walls: per line, the `ts`, the repo,
and the one field that matters (`trigger` for an invoke, `outcome.verdict` for a
run, `missed` for an annotation). Offer the raw line if they want it.

The reading worth saying out loud: **more `invoke` than `run` for the same skill
means runs that started and never finished.** That gap is the file's main signal.

## 6. why-denied

```
grep commit ~/.claude/router-state/router.log | grep deny | tail -3
```

No matching line: say exactly that. A commit that was never denied is not a
mystery to solve, and the log holds every decision the gate made.

Otherwise take the last line, quote it, and decode its `why` (§3) into the next
move:

| why | what happened | next move |
|---|---|---|
| `marker missing` | no `/verify` has passed in this worktree, or the last one was not-safe and cleared the marker | run `/verify`, fix what it reports, commit again |
| `tree changed since <ts>` | a passing verify exists, but a file moved after it — the gate is fingerprint-exact | run `/verify` again on the tree as it stands now |
| `fingerprint unavailable (git failed)` | the tree could not be hashed, so the gate failed closed rather than passing on a partial hash | check `git status` works in that repo (a lock file, a broken index), then retry |

Also check the line's `ts` against now: an hours-old deny is often a question
about a commit that has long since gone through.

The deliberate override, when the commit genuinely should not wait for a verify:

```
SKIP_VERIFY=1 git commit -m "<message> (skip verify: <reason>)"
```

Offer it second, never first, and always with the reason in the message — it is
logged as `override SKIP_VERIFY` and the message is where the why survives. Do
not suggest any other way around the gate.

## 7. install / uninstall

Two steps, and the split between them is the point.

1. **Dry-run first**, always:
   ```
   node ~/claude-skills/router/install.mjs --dry-run
   node ~/claude-skills/router/install.mjs --dry-run --uninstall
   ```
   `router: nothing to change` means it is already in the state being asked for:
   stop, say so, write nothing. Otherwise print the change list verbatim — those
   lines are exactly what the real run will do.
2. **Ask, then run.** Ask for an explicit "yes" to that change list, in its own
   turn. Only after it:
   ```
   node ~/claude-skills/router/install.mjs
   node ~/claude-skills/router/install.mjs --uninstall
   ```
   Neither is pre-allowed by this skill, so Claude Code raises its own permission
   prompt. That prompt is the second confirmation and it is deliberate; do not
   look for a path around it.

Then report:

- The **backup** line it prints (`settings.json.bak-<timestamp>`) — the previous
  settings file, copied before anything was written. Every write is idempotent
  and foreign entries in the file are left alone.
- Each change line, as printed.
- **New sessions pick it up.** This session's hooks were captured when it
  started, so the router keeps behaving the old way here until a new session
  starts. Say this every time; it is the surprise otherwise.
- `--settings <path>` aims all of it at another settings file (how the tests
  drive it). On uninstall, an `SKILL_RUNS_DIR` you changed by hand is kept, not
  removed.

## 8. doc

Point at the file and the section in it, then read that section and answer from
it. Never answer from memory of a doc that is sitting right there.

- `~/claude-skills/router/README.md` — the reference: the rule table, the gate
  step by step, how the fingerprint is computed, **what the gate cannot see**,
  the record types, the tests.
- `~/claude-skills/router/docs/GUIDE.md` — the walkthrough, in English.
- `~/claude-skills/router/docs/GUIDE.ko.md` — the same in Korean.

If a path is not there, say it is missing rather than paraphrasing what it would
have said.

## 9. Boundaries

| Tool | Question it answers |
|---|---|
| `/verify` | **Did the gate pass?** It runs the gates and writes the marker. |
| `skill-router` | **Is the gate on, what did it decide, and why?** Reads and reports. |
| `/explain-diff` | Should this change **exist**? |
| `/code-review` | Is this change **wrong**? |

This skill never runs the gate, never edits the router's scripts or rules, and
never touches a repo. Its only writes are the two installer commands in §7,
against `~/.claude/settings.json`, after an explicit yes.

## Verification (self-check before you report — mandatory)

- Is every "installed" / "not installed" backed by the **dry-run output** in this
  run, not by hook entries you read in the settings file?
- Is every "gated" / "not gated" backed by the repo name from `git rev-parse`
  **compared against** the `repo_groups` you just printed?
- Did you `cat` the marker before saying it exists, and quote its `ts` as written?
- Did you quote log lines rather than summarizing them into a conclusion? Where
  no line matched, does the report say "no matching line" instead of inferring?
- Are the counts real command output (`wc -l`, `grep -c`), with a zero-match
  `grep -c` read as 0 rather than an error?
- For install/uninstall: was the dry-run shown, was an explicit yes given, and
  did the report name the backup file and the new-session caveat?

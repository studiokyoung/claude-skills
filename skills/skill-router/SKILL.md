---
name: skill-router
description: Operator console for the skill router — the hooks that gate web-repo commits behind /verify, remind about reuse-scout and save-memory, self-check at session start and resume, and record every skill run (remind, invoke, gate, run, annotation). Use for "/skill-router", "is the router on", "why didn't the reminder fire", "why was my commit denied", "the verify gate is blocking me", "add a repo to the gate", "turn the router off / back on", "show me the router log / the run records". Reports only what a command in this run printed, from the read-only console and the self-check, and installs or uninstalls after an explicit yes. Not the gate itself (that is /verify), not the weekly review (/skill-review), not a diff review (/explain-diff).
user-invocable: true
argument-hint: "[status|log [n]|rules|records [skill]|why-denied|install|uninstall|doc]"
metadata:
  version: "1.1.0"
allowed-tools:
  - Bash(node ~/claude-skills/router/status.mjs:*)
  - Bash(node /Users/kyounghoonkim/claude-skills/router/status.mjs:*)
  - Bash(node ~/claude-skills/router/selfcheck.mjs --cli:*)
  - Bash(node /Users/kyounghoonkim/claude-skills/router/selfcheck.mjs --cli:*)
  - Bash(node ~/claude-skills/router/install.mjs --dry-run:*)
  - Bash(node /Users/kyounghoonkim/claude-skills/router/install.mjs --dry-run:*)
  - Bash(tail:*)
  - Bash(cat:*)
  - Bash(ls:*)
  - Bash(grep:*)
  - Bash(wc:*)
  - Bash(git status:*)
  - Read
  - Grep
  - Glob
---

# skill router (operator console)

The router is four hooks, so it has no command of its own: it fires on prompts
and tool calls, denies a commit that has no passing `/verify` behind it, checks
itself when a session starts or is resumed into, and appends a line to a log
nobody reads until something surprises them. This skill is the human end of it —
what is installed, what fired, what it decided, and how to turn it on or off.

**The prime directive: read it, don't remember it.** Every line you report comes
from a command run in *this* turn. Two read-only programs do almost all of it —
`status.mjs` (what is on disk right now) and `selfcheck.mjs --cli` (whether it
still fires) — and the right answer is usually their output, quoted. Do not
recompute by hand what they already computed: the rules for repo identity,
worktrees, submodules and rotation live in them, and a second hand-rolled version
of those rules is how a confident wrong answer gets printed.

Write the prose in the language the user is prompting in. Keep paths, rule ids,
log lines, JSON keys, and the tools' own output as they are.

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

For the weekly review use `/skill-review` — it aggregates the records into a
report and proposes edits; this skill only reads the current state.

Anything else: run §2 and add one line naming the valid subcommands. If the word
names a tracked skill (`verify`, `reuse-scout`, `save-memory`, `explain-diff`),
read it as `records <skill>` instead.

## 2. status

Two commands, in this order. Nothing else, and nothing hand-computed on top.

```
node ~/claude-skills/router/status.mjs --md
node ~/claude-skills/router/selfcheck.mjs --cli
```

The first is the status card — print its output as it came, in a fenced block.
It is read-only (it writes nothing, not even a directory) and it already knows
the things that are easy to get wrong by hand: repo identity through the common
git dir (so a linked worktree stays in its group, and a submodule falls back to
its own toplevel), the marker's real path and age, a log tail that spans the
rotated file, and record counts parsed per type. `--cwd <dir>` points it at
another repo, `--log <n>` widens the tail.

The second answers the question the card cannot: does the router still *fire*.
Six checks, roughly half a second. Report its table as it printed. A blocking
failure is ❌, exits 1, and its reason is the repair instruction; an
informational one is ⚠️, counted as a note in the last line, and never flips the
verdict or the exit code (the Node version check is the informational one today).
A ⚠️ is worth repeating to the user; it is not worth calling the router broken.

Then read the card back in one or two lines. What each row means:

- **hook rows.** `ok … (this router)` is registered and pointing here.
  `(ANOTHER checkout: <dir>)` means the hooks that actually run are a different
  copy of the router than the one you are reading, which is the failure a plain
  "the hooks are in the file" check misses. `MISSING` is one hook not registered.
- **allow.** Only the rules the router expects are named present or MISSING; the
  trailing count of other `Skill(...)` allows is everyone else's, not the
  router's. Never present that count as the router's own.
- **settings that will not parse.** The card says `does not parse as JSON`, and
  the installer refuses with `router: cannot parse …` and exit 1. That state is
  **"cannot tell"**, not "not installed": fix the JSON before concluding anything
  about the hooks.
- **repo.** `GATED by <rule id>` is derived from the rule table (which
  `pre-commit` block rule actually covers this repo), not from a name appearing in
  a list. Report the rule id with it.
- **marker.** The path printed is `<git-dir>/verify-pass`, which in a linked
  worktree is `.git/worktrees/<name>/verify-pass`, not the main checkout's
  `.git/`. Present means a `/verify` passed at that `ts`, over the tree as it was
  then; it is not a promise the next commit passes, since the gate recomputes the
  fingerprint at commit time.
- **caveats.** Keep the caveat line verbatim: *hooks are captured at session
  start: a session opened before the install does not run them until it is
  restarted.* It is unconditional because no process can tell from the inside
  whether this session predates the settings file.

Close with one line on what it means here: gated and marked, gated and unmarked
(the next commit is denied until `/verify` runs), or not gated (the commit gate
never fires in this repo, reminders still can).

## 3. log [n]

```
tail -n 20 ~/.claude/router-state/router.log
```

`n` from the arguments, default 20. The file rotates to `router.log.1` at 1 MB,
so a window that reaches back far enough needs both, oldest file first:

```
grep -h . ~/.claude/router-state/router.log.1 ~/.claude/router-state/router.log 2>/dev/null | tail -n 40
```

There is no `router.log.1` until the log first passes 1 MB, which is the normal
state for a while: `2>/dev/null` is what keeps that expected absence out of the
report, and its silence is not evidence of anything.

Print the lines and then the legend. Do not paraphrase a line into a verdict, and
do not restate its timestamp in another zone: the log is UTC ISO, the marker and
the records are local time with an offset, and quietly mixing them is how two
events an hour apart look simultaneous.

Six tab-separated columns: `ts · event · rule · repo · decision · why`. The rule
column is the rule id that decided, or `-` when no rule was involved (an
out-of-scope commit, a load failure), and it is the column that says *which* rule
to go read in §4.

| event | decisions you will see |
|---|---|
| `prompt` | `user-invoked` (you typed the slash command), `remind` (a rule fired) |
| `commit` | `allow` / `deny` from the verify gate |
| `new-file` | `remind` (context injected) or `deny-once` (first attempt denied, retry passes) |
| `skill` | `invoke` (a tracked skill ran), `skip`, `record-failed`, `rules-load-failed` |
| `records` | `record-failed`, `record-skipped` (the rule that decided names no skill, so there was no buffer to write to) |
| `health` | `ok` / `fail` from a self-check, the session hook and `--cli` alike. The log line has no `via`; that field is in `router.jsonl` |
| `rules` | `rules-load-failed` — the table did not parse, so everything was let through. The prompt and tool hooks log it under `rules`, the skill hook under `skill`, so a broken table shows up on both rows |

The `why` column on a `commit` line is a fixed vocabulary. The first five are
passes, the last three are the denials:

| why | meaning |
|---|---|
| `out-of-scope` | no `pre-commit` rule covered this repo; the gate never applied |
| `override SKIP_VERIFY` | `SKIP_VERIFY=1` led the command; a deliberate, logged override |
| `nothing-to-commit` | the commit carried no paths the hook could see |
| `docs-only` | every path matched `docs_only` (`.md`, `.mdx`, `.txt`, `.markdown`) |
| `verified <ts>` | the marker's fingerprint still matches the live tree |
| `marker missing` | no `verify-pass` marker in this worktree |
| `tree changed since <ts>` | there was a passing verify, then the tree moved |
| `fingerprint unavailable (git failed)` | the tree could not be hashed; the gate fails closed |

An empty or missing log means no hook has logged yet (a fresh install, or
`ROUTER_STATE_DIR` pointing elsewhere). It does **not** mean the router is off —
§2 answers that.

## 4. rules

Everything the router does is policy in one file; the scripts are generic. The
status card's `rules` block already lists the table (`<id> · <event> · <repos> ·
<mode> → <skill>`), the repo groups, and `pretooluse_context`, so read it from
there rather than re-parsing the JSON. Open
`~/claude-skills/router/skill-rules.json` when the exact regex matters, and quote
the file, not a summary of it.

How to read a row: `event` is when it is checked (`prompt`, `pre-commit`,
`new-file`), `repos` is a group name / `*` / an explicit list, `mode` is `block`
(only valid for `pre-commit`) or `remind`, and the arrow names the skill the rule
asks for and whose record buffer it writes into.

**Add a repo to the gate:** append its directory name to `repo_groups.web` in
`~/claude-skills/router/skill-rules.json` (the `corp` group is the save-memory
reminder's scope). The name is the repository root's basename, so a linked
worktree needs no separate entry.

**Add a rule:** one object in `rules`, plus a matching sentence and a near-miss
that must *not* match in `router/test/rules.test.mjs`. No script change.

Either way, run the suite afterwards — quote the glob, since Node 22 reads the
bare directory form as a module path:

```
cd ~/claude-skills && node --test 'router/test/*.test.mjs'
```

Rules are re-read by every hook process, so an edit applies to the very next tool
call with no restart. Only `settings.json` changes (§7) need a new session.

This skill reports the edit; it does not make it. Say which file, which key, and
what to add, and let the change happen as a normal edit the suite then covers.

## 5. records [skill]

Run records live in one `<skill>.jsonl` per skill, appended and never edited in
place. **Take the directory from the status card, every time.** Its `records`
row prints `SKILL_RUNS_DIR=<dir>` and its `records` block prints the directory
being read; `~/.claude/skill-runs/` is only the default, and `SKILL_RUNS_DIR` in
the settings file can point somewhere else. Reading the default while the router
writes elsewhere produces a confident report about the wrong files, so the card is
the single source of truth for this path.

That block is also the count source (it parses each line and counts by type). When
it says `no records yet at <dir>`, say exactly that — nothing has been recorded,
which is not the same as the router being off, and a fresh install looks like this.

With a skill named, read the last few lines (`<runs dir>` is the card's path):

```
tail -n 5 <runs dir>/<skill>.jsonl
grep -c '"type":"gate"' <runs dir>/<skill>.jsonl
```

`grep -c` exits 1 when it counts zero. That is a zero, not a failure.

Five types, one question each:

| type | the question it answers |
|---|---|
| `remind` | did the router ask for this skill, from which rule, and on what wording (`pattern_index`, `prompt_excerpt` or `target`) |
| `invoke` | did the skill actually start, and who triggered it (`user` typed it, `router` reminded first, `model` chose it) |
| `gate` | what did the commit gate decide, on how many paths (`candidates`), against which marker (`marker_ts`, `marker_age_s`) |
| `run` | how did the run end (`outcome.verdict`, gates, `caught`) and on which skill `version` |
| `annotation` | what did a finished run miss, appended later by `debrief`, pointing at it by `ref` |

Plus one that is not a skill's: `health` lines in `<runs dir>/router.jsonl`, one
per self-check, the session hook and `--cli` alike (`via` says which), which is the
router's own buffer. A scheduled `--cli` run is how that history fills between
sessions.

Summarize the tail rather than dumping JSON walls: per line, the `ts`, the repo,
and the one field that matters for its type. Offer the raw line if they want it.

Two readings worth saying out loud: **more `invoke` than `run` for one skill means
runs that started and never finished**, and **a `remind` with no `invoke` after it
in the same session is a reminder the model ignored**. Both are what
`/skill-review` turns into edits.

## 6. why-denied

Denials are `commit` lines with decision `deny`, and they may sit in the rotated
file, so read both, oldest first:

```
grep -h commit ~/.claude/router-state/router.log.1 ~/.claude/router-state/router.log 2>/dev/null | grep deny | tail -3
```

Same `2>/dev/null` as §3: `router.log.1` does not exist until the log first
passes 1 MB, and that absence is expected, not a finding.

No matching line: say exactly that, and say what it does not prove. The log
rotates at 1 MB, so an old deny may no longer exist; and the gate only sees
`git commit` typed as a Bash command, so a commit made through a script, a
wrapper, or your own terminal never reached it at all (`What the gate cannot see`
in the router README).

Otherwise take the last line, quote it, and decode its `why` (§3) into the next
move:

| why | what happened | next move |
|---|---|---|
| `marker missing` | no `/verify` has passed in this worktree, or the last one was not-safe and cleared the marker | run `/verify`, fix what it reports, commit again |
| `tree changed since <ts>` | a passing verify exists, but a file moved after it; the gate is fingerprint-exact | run `/verify` again on the tree as it stands now |
| `fingerprint unavailable (git failed)` | the tree could not be hashed, so the gate failed closed rather than passing on a partial hash | check `git status` works in that repo (a lock file, a broken index), then retry |

Also check the line's `ts` against now: an hours-old deny is often a question
about a commit that has long since gone through.

The deliberate override, when the commit genuinely should not wait for a verify:

```
SKIP_VERIFY=1 git commit -m "<message> (skip verify: <reason>)"
```

Offer it second, never first, and always with the reason in the message. It is
logged as `override SKIP_VERIFY` and recorded with the paths it carried, so the
override is on the record either way; the message is where the *why* survives. Do
not suggest any other way around the gate.

## 7. install / uninstall

Two steps, and the split between them is the point.

1. **Dry-run first**, always:
   ```
   node ~/claude-skills/router/install.mjs --dry-run
   node ~/claude-skills/router/install.mjs --dry-run --uninstall
   ```
   `router: nothing to change` means the file is already in the state being asked
   for: stop, say so, write nothing. Any change list is exactly what the real run
   would do; print it verbatim. `router: cannot parse …` (exit 1) means the
   settings file is broken and nothing can be decided until it is fixed.
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

- **The backup, if there was one.** The installer copies an existing settings
  file to `settings.json.bak-<timestamp>` and prints that path. There is no
  backup line when no settings file existed yet, so name the file only if it was
  printed.
- Each change line, as printed. Router entries registered from a checkout that
  has since moved are repointed rather than duplicated, and hooks that are not the
  router's are left alone.
- **`nothing to change` on an uninstall is not always "already clean."** The
  installer only removes entries whose command path is *this* checkout. Run from
  a different copy of the router, it finds none of its own and reports nothing to
  change while the registered hooks keep running. The status card's hook rows name
  the directory they actually run from; uninstall from there.
- **New sessions pick it up.** *Hooks are captured at session start: a session
  opened before the install does not run them until it is restarted.* Say this
  every time; it is the surprise otherwise.
- `--settings <path>` aims all of it at another settings file (how the tests drive
  it). On uninstall, an `SKILL_RUNS_DIR` you changed by hand is kept, not removed.

## 8. doc

Point at the file and the section in it, then read that section and answer from
it. Never answer from memory of a doc that is sitting right there.

- `~/claude-skills/router/README.md` — the reference: the rule table, the gate
  step by step, how the fingerprint is computed, **what the gate cannot see**, the
  five record types and what the loop computes from them, the self-check, the
  weekly review, the tests.
- `~/claude-skills/router/docs/GUIDE.md` — the walkthrough, in English.
- `~/claude-skills/router/docs/GUIDE.ko.md` — the same in Korean.

If a path is not there, say it is missing rather than paraphrasing what it would
have said.

## 9. Boundaries

| Tool | Question it answers |
|---|---|
| `/verify` | **Did the gate pass?** It runs the gates and writes the marker. |
| `skill-router` | **Is the router on, what did it decide, and why?** Reads and reports. |
| `/skill-review` | **Is any of this working?** The weekly aggregation and the edits it argues for. |
| `/explain-diff` | Should this change **exist**? |
| `/code-review` | Is this change **wrong**? |

This skill never runs the gate, never edits the router's scripts or rules, and
never touches a repo. Its only writes are the two installer commands in §7,
against `~/.claude/settings.json`, after an explicit yes.

## Verification (self-check before you report — mandatory)

- Is every claim about what is installed backed by **this run's** `status.mjs` and
  `selfcheck --cli` output, rather than by a settings file you skimmed? A settings
  file that does not parse is "cannot tell", never "not installed".
- Is "gated" reported with the rule id the card derived it from, and the marker
  with the path and `ts` the card printed?
- Did you quote log lines rather than summarizing them into a conclusion, keep
  their timestamps as printed, and, where nothing matched, say "no matching line"
  plus what that does not prove?
- Did anything that could reach past a rotation read `router.log.1` as well?
- Are the record counts the card's (or a real `grep -c`), with a zero-match
  `grep -c` read as 0 rather than an error, and is "no records yet" reported as
  itself?
- For install/uninstall: was the dry-run shown, was an explicit yes given, and did
  the report name the backup file **if one was printed** and repeat the
  session-start caveat?

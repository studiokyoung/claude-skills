# router

Hooks that make the skills in this repo fire at the right moment, plus a local
record of every run so the skills can be improved from evidence later.

**Guides:** [`docs/GUIDE.md`](docs/GUIDE.md) (English) and [`docs/GUIDE.ko.md`](docs/GUIDE.ko.md) (한국어) walk the whole thing through; this file is the reference.

## What it does

- **verify gate.** In the repos you list under `repo_groups.web`, a `git commit`
  made through Claude Code is denied unless a passing `/verify` ran on that exact
  tree. `/verify` writes `.git/verify-pass` with a fingerprint of the tree; any later
  edit changes the fingerprint and the gate asks for another run. Commits that touch
  only docs pass. `SKIP_VERIFY=1 git commit ...` is the deliberate override.
- **reuse-scout reminders.** When a prompt asks to build a component, hook, util,
  page, or feature, the model is told to run `reuse-scout` first. If it still starts
  writing a new file under `components/`, `hooks/`, `lib/` and similar paths without
  having run it, it is reminded once more (once per session).
- **save-memory reminder.** In the repos under `repo_groups.corp`, wrap-up phrasing
  ("wrap up", "마감", ...) triggers a reminder to run `save-memory` if it has not run.
- **self-check.** At every session start the router probes itself against temp
  directories and says nothing if it still works. A broken install announces
  itself in one line instead of going quiet for a month.
- **weekly review.** `report.mjs` aggregates the records into one deterministic
  report (conversions, gate cycles, catch rate per version, candidate edits), and
  `/skill-review` is the Friday ritual that reads it and files the week.
- **run records.** The evidence layer: every reminder the router delivers, every
  commit decision the gate makes, every invocation of a tracked skill (with how it was
  triggered: typed by you, suggested by the router, or picked by the model), the
  outcome each skill appends when it finishes, and whatever `debrief` later says a run
  missed. One JSONL file per skill in `~/.claude/skill-runs/`. Run records never
  touch a repo; the only thing `/verify` writes inside a repo is `.git/verify-pass`,
  which git ignores.

## Install

First make the rules yours: open `router/skill-rules.json` and replace the
repository names under `repo_groups` with your own (the `web` group is where the
commit gate applies, the `corp` group is where the save-memory reminder does).
Then:

```bash
node ~/claude-skills/router/install.mjs             # merge into ~/.claude/settings.json (backup first)
node ~/claude-skills/router/install.mjs --dry-run   # print the changes without writing them
node ~/claude-skills/router/install.mjs --uninstall
```

Requirements: Node 22+, git. No npm packages. The installer registers four hooks:

| Event | Matcher | Script | Timeout |
|---|---|---|---|
| `UserPromptSubmit` | (none, so every prompt) | `on-prompt.mjs` | 5s |
| `PreToolUse` | `Bash\|Write` | `pre-tool.mjs` | 5s |
| `PostToolUse` | `Skill` | `post-skill.mjs` | 5s |
| `SessionStart` | (none) | `selfcheck.mjs` | 10s |

The last one is the [self-check](#self-check-sessionstart), and its budget is
longer because it spawns the other three before it answers.

It also adds one `permissions.allow` entry per name in `allow_skills`
(`Skill(verify)`, `Skill(reuse-scout)`, `Skill(skill-router)`,
`Skill(skill-review)`: a skill with `allowed-tools` otherwise stops at a
permission prompt, which auto-denies in non-interactive runs), and sets
`env.SKILL_RUNS_DIR` to `~/.claude/skill-runs`.

Every write is idempotent, so a second run prints `router: nothing to change`, and
the existing settings file is copied to `settings.json.bak-<timestamp>` before
anything is written. `--settings <path>` points all of it at another settings file,
which is how the tests drive it. After installing, run the suite once
([Tests](#tests)): all green means the hook I/O still matches this Claude Code
version.

## The rule table

`router/skill-rules.json` is the only place policy lives. The scripts are generic.

```json
{
  "repo_groups": { "web": ["portfolio-html"], "corp": ["corp-app"] },
  "docs_only": "\\.(md|mdx|txt|markdown)$",
  "pretooluse_context": "additionalContext",
  "track_skills": ["verify", "reuse-scout", "save-memory", "explain-diff", "skill-router", "skill-review"],
  "allow_skills": ["verify", "reuse-scout", "skill-router", "skill-review"],
  "rules": [ { "id": "...", "skill": "...", "event": "prompt | pre-commit | new-file", "repos": "web | corp | * | [\"name\"]", "mode": "block | remind", "once_per_session": true, "unless_ran": "reuse-scout", "patterns": ["regex"], "sample": "a sentence that must match", "paths": ["regex"], "message": "..." } ]
}
```

- `track_skills` extends the set of skills the hooks recognize and write `invoke`
  records for; every skill named by a rule is already in it. `allow_skills` is what
  the installer turns into `permissions.allow` entries. `docs_only` is matched
  case-insensitively against each path a commit would carry.
- `repos` is a group name, `*`, or an explicit list of repository directory names.
  The name is the basename of the repository root, taken from
  `git rev-parse --git-common-dir`, so a linked worktree answers with its main
  checkout's name and stays in the same group. Outside a git repo only `*` rules
  apply.
- `sample` on a `prompt` rule is a sentence that must match it. The session
  self-check sends that exact sentence through the real hook, and the test suite
  holds it to still matching, so a pattern edit that quietly stops working fails
  in the suite rather than at somebody's next session start.
- `event: prompt` matches `patterns` (case-insensitive, Unicode) against the first
  4000 characters of the prompt. `event: new-file` matches `paths` against the
  repo-relative path of a file that does not exist yet (the `Write` tool's
  `file_path`, or a Bash `>` / `>>` / `tee` target); a target starting with `~` or
  containing `$` is unexpanded shell text rather than a literal path, so it is
  skipped without spending the session's one reminder. `event: pre-commit` fires on
  a `git commit` in a Bash command.
- `mode: block` is only valid for `pre-commit`. Everything else is `remind`.
- `once_per_session` and `unless_ran` read the session ledger in
  `~/.claude/router-state/<session_id>.json`.
- A `remind` rule with no `message` never fires, since there would be nothing to
  say. A `block` rule without one still denies, with `verify gate: <why>` as the
  reason.
- `pretooluse_context` picks how a `new-file` reminder is delivered:
  `additionalContext` (no interruption) or `deny-once` (the first attempt is denied
  with the reminder as the reason; the retry passes). `additionalContext` is the
  measured mode on this machine and what the shipped file uses; any other value
  falls back to `deny-once`. `test/probe-settings.json` plus `probe.mjs` show how to
  check it against your own Claude Code version.
- `{why}` in a block message is replaced with `marker missing`,
  `tree changed since <ts>`, or `fingerprint unavailable (git failed)`.

The patterns are deliberately narrow, because a reminder on the wrong prompt is
worse than no reminder. The English verbs and nouns are word-bounded, `build` and
`rebuild` are both matched but guarded, so "the build is broken" does not match,
`추가` does not match `추가로` or `추가적`, and `마감` does not match `마감일`.

### Adding a rule

Add one object to `rules`, run the suite, and add a test sentence to
`test/rules.test.mjs` for each new pattern: one that must match and one near miss
that must not. No script changes are needed.

## The verify gate in detail

1. `pre-tool.mjs` sees a Bash command segment that starts with `git commit` (also
   inside `&&` chains, behind `env FOO=1`, with `-C <path>`, with `--amend`). It has
   to start the segment, so `echo "git commit"` is not a commit.
2. It resolves the repo the command itself targets: `git -C <path>`, or a preceding
   `cd <path>` in the same command (a relative `-C` composes with the `cd`, the way
   the shell resolves it), falling back to the hook's own cwd when that base cannot
   be resolved. The base directory is then resolved through symlinks, since git
   answers with physical paths and a symlinked checkout would otherwise put every
   pathspec outside the repo. Pathspecs themselves are never resolved that way: one
   may name a file that does not exist yet. No `pre-commit` block rule in scope
   means allow, with no user-visible output (still logged).
3. `SKIP_VERIFY=1` heading a command segment (an env assignment, the way the shell
   reads it) means allow, logged as `override SKIP_VERIFY`. The same text inside
   quotes or a heredoc body is data, not an override, so a commit message may
   mention it without granting one.
4. It computes the set of paths the commit would include: staged files, plus tracked
   changes for `-a`, plus the commit's own pathspecs (`git commit -m x web/a.tsx`),
   plus whatever an earlier `git add` in the same command names, each resolved
   against its own base. Empty set: allow. Every path matching `docs_only`: allow.
   A command substitution in a pathspec position makes the set unknown rather than
   empty, and both shortcuts are skipped.
5. Otherwise it compares the live fingerprint with `.git/verify-pass`. Same: allow.
   Missing, different, or not computable: deny, and the reason is fed back to the
   model.

The fingerprint is a SHA-256 over `HEAD`, the porcelain status list collapsed to a
change class, the file modes, and one line per changed file. A file that exists in
`HEAD` contributes its git blob hash, so a same-length edit still moves the
fingerprint. A file that does not (untracked, or newly added to the index), and any
file over 8 MB, contributes `size:mtime` instead: its content is new by definition,
and reading it is what costs. One real checkout carries 456 MB of untracked images,
which took about 2 seconds per gate to hash and crowded the 4 second git timeout,
and a timeout there jams the gate and `mark-pass` alike. The trade is that touching
a new file without editing it can move the fingerprint, which costs one more
`/verify`.

So the fingerprint is content-based for tracked files, mode-aware (a `chmod` on an
already dirty file moves it), and staging-neutral: running `/verify`, then
`git add`, then committing stays valid, while any actual edit in between does not.
It fails closed. If any git call fails the fingerprint is unavailable and the gate
denies with `fingerprint unavailable (git failed)` rather than passing on a hash
computed over less than the whole tree.

In a linked worktree the marker lives in that worktree's own git directory, so two
worktrees of the same repository each need their own passing `/verify`.

`/verify` writes the marker through `skills/verify/references/mark-pass.mjs` (a shim
over `router/mark-pass.mjs`) only when its verdict is safe, and clears it otherwise:

```bash
node ~/claude-skills/router/mark-pass.mjs --root <repo> --gates '{"git":"PASS","typecheck":"PASS","tests":"PASS","screenshots":"PASS"}' --routes '["/","/work/x"]'
node ~/claude-skills/router/mark-pass.mjs --root <repo> --clear
```

`--routes` is a JSON array, and a bare comma list is accepted too (`--routes /` and
`--routes /,/work/x` both become `["/"]` and `["/","/work/x"]`), since that is how
routes are usually at hand. A value that opens with a bracket and does not parse is
still an error, and so is one that leaves nothing after the split: the marker is the
record of what `/verify` actually ran, and a route it never checked must not appear
there. `--gates` is a map, not a list, so it stays strict JSON. The failures
`mark-pass` reports, each meaning no marker was written: `not-a-git-repo`,
`bad-gates-json`, `bad-routes-json`, `fingerprint-failed`, `marker-write-failed`.

## What the gate cannot see

It reads one Bash command at a time, as text. Everything below reaches git without
passing that text, and none of it is denied:

- Commits git makes on its own behalf: `git revert`, `git merge`, `git cherry-pick`,
  `git rebase --continue`, `git stash` (the verb has to be `commit`).
- A commit inside a script or an npm target: `./release.sh`, `npm run ship`. The
  hook sees the wrapper, not the `git commit` two files down.
- Wrappers that hide the command from the parser: `timeout 60 git commit ...`,
  `bash -c "git commit ..."`, `eval`, `xargs`, a git alias that commits.
- Commits typed in your own terminal. This is a gate on an agent claiming done, not
  a git `pre-commit` hook, and that is deliberate: your own commits are yours.
- Anything in a repository outside `repo_groups.web`.

The gate is a floor for the common path, not a proof. Where it cannot see, the
`/verify` habit is still what protects the tree.

## Run records

`~/.claude/skill-runs/<skill>.jsonl`, one JSON object per line, five types, here in
the order a session produces them:

```json
{"type":"remind","rule":"reuse-scout-prompt","delivery":"prompt","repo":"portfolio-html","session_id":"...","prompt_id":"...","pattern_index":1,"prompt_excerpt":"버튼 컴포넌트 하나 만들어줘","id":"reuse-scout-20260901T044743Z-2dd2","ts":"2026-09-01T00:47:43.227-04:00","skill":"reuse-scout"}
{"type":"invoke","repo":"portfolio-html","session_id":"...","prompt_id":"...","trigger":"user","id":"verify-20260831T233001Z-3f2a","ts":"2026-08-31T19:30:01.412-04:00","skill":"verify"}
{"type":"gate","repo":"portfolio-html","session_id":"...","prompt_id":"...","decision":"deny","why":"marker missing","candidates":1,"docs_only":false,"marker_ts":null,"marker_age_s":null,"command_excerpt":"git commit -m \"feat: toast\"","id":"verify-20260901T044743Z-f6e8","ts":"...","skill":"verify"}
{"type":"run","version":"1.1.0","repo":"portfolio-html","cwd":"/.../web","session_id":"...","session_inferred":true,"prompt_id":null,"git":{"head":"f60064b6da9e","branch":"main","changed":1},"outcome":{"verdict":"safe","gates":{"git":"PASS","typecheck":"PASS","tests":"PASS","screenshots":"PASS"},"tiles":9,"routes":["/"],"duration_s":84},"caught":[],"id":"verify-20260831T233105Z-9c1d","ts":"...","skill":"verify"}
{"type":"annotation","ref":"verify-20260831T233105Z-9c1d","repo":"portfolio-html","missed":"carousel mobile overflow","by":"debrief 2026-09-02","note":"tiles were desktop-only","id":"verify-20260902T140000Z-77aa","ts":"...","skill":"verify"}
```

- `remind` is one line per reminder actually delivered, written into the buffer of
  the skill it asked for. `delivery` is `prompt`, where `pattern_index` names which of
  the rule's patterns matched and `prompt_excerpt` keeps the first 160 characters of
  the prompt with whitespace collapsed, or `new-file`, where `target` is the
  repo-relative path that was about to be created. The whole prompt is never stored.
- `invoke` is written by the hooks. `trigger` is `user` (you typed the slash
  command, written by the prompt hook), `router` (a reminder for that skill fired
  earlier in the session) or `model` (the model picked the skill on its own); the
  last two are written by the `Skill` hook, for tracked skills only.
- `gate` is one line per `git commit` decision a `pre-commit` rule was in scope for,
  written into that rule's skill buffer. Out of scope means no gate stood there, so
  nothing is written; a rule that is in scope but names no `skill` has no buffer to
  write to, and that gap is logged as `record-skipped` instead of being dropped.
  `candidates` is how many paths the commit would have carried, counted on the
  `SKIP_VERIFY` path too so an override stays comparable with the denies around it, and
  null only when git could not list them. `docs_only` says the docs shortcut is what
  allowed it, `marker_ts` and `marker_age_s` say which passing `/verify` was accepted
  and how old it was, and `command_excerpt` keeps the first 120 characters of the
  command.
- `run` is written by the skill itself as its last step through `record-run.mjs`,
  which is the only run-record write in the system: no hook ever writes a `run`
  line, so an `invoke` with no `run` beside it is exactly what a skill that quit
  before finishing looks like.
  `version` comes from the skill's `metadata.version`, so outcomes are comparable
  per skill version. Everything in `--json` except `caught` lands under `outcome`.
  `session_id` is inferred from the newest ledger for the same repo within the last
  three hours, and `session_inferred` says whether one was found. `git` is the working
  context of `--cwd` when the skill finished (short HEAD, branch, and how many paths
  were dirty), all three null outside a repository so a missing tree never reads as a
  clean one. `prompt_id` is null until a skill passes `--prompt-id`.
- `annotation` is appended later (by `debrief`) and points at a run by `ref`.
  Records are never edited in place.

```bash
node ~/claude-skills/router/record-run.mjs --skill verify --cwd <repo> [--prompt-id <id>] --json '{"verdict":"safe","gates":{"git":"PASS"},"caught":[]}'
node ~/claude-skills/router/record-run.mjs --skill verify --type annotation --json '{"ref":"<run id>","missed":"...","by":"debrief 2026-09-02"}'
```

It answers with the id and the file it appended to, and it never throws: a bad call
comes back as `{"ok":false,"reason":"..."}` with `missing --skill`, `invalid --json`
or, for an annotation, `missing ref`.

### What the loop can compute from this

Every line carries `repo`, `session_id` and `prompt_id`, which is what makes the
buffers joinable. A `remind` followed by an `invoke` of the same skill in the same
session is a reminder that converted; a `remind` with nothing after it is one the
model ignored, and the excerpt plus the pattern index say which wording and which
pattern produced it, so a rule that reminds and never converts can be rewritten
instead of guessed at. The `gate` lines replay the deny, verify, allow cycle: a deny
with `marker missing`, then a `run` with a safe verdict, then an allow whose
`marker_age_s` is the gap between them, while a long stretch of allows with
`docs_only` true says the gate is mostly waving documentation through and covering
less than it looks. Grouping `run` lines by `version` and reading the `annotation`
lines that point at them gives the catch and miss rate per skill version, which is
the number that says whether an edit to a skill actually made it better.

None of that has to be computed by hand: `report.mjs` below does exactly these
joins and prints them, so the weekly review argues with counts instead of
impressions.

## Self-check (SessionStart)

`selfcheck.mjs` runs at every session start and answers the one question the log
cannot: **is the router still wired, and does it still fire?** Six checks, about
450 ms, silent while everything passes.

| check | what it proves |
|---|---|
| `settings` | `~/.claude/settings.json` parses, all four hook entries are registered, each one from THIS checkout, every `allow_skills` name is in `permissions.allow`, and `env.SKILL_RUNS_DIR` is set |
| `rules` | the table loads, every reminder rule has a message, every group a rule names exists, and `pretooluse_context` is one of the two values |
| `probe.on-prompt` | the prompt hook still turns the reuse-scout rule's own `sample` sentence into a reminder |
| `probe.pre-tool` | a new file under `components/` still draws the backstop reminder, and an unverified commit in a gated repo is still denied |
| `probe.post-skill` | a `Skill` call still lands in a session ledger |
| `node` | Node 22 or newer |

The three probes spawn the real hook scripts against a throwaway `HOME`, state
directory, records directory and git checkout, with `SKILL_ROUTER_PROBE=1` in the
child environment, so a probe can never write a real record and can never
re-enter the check. The four spawns run in parallel, which is what keeps the
whole thing inside a session-start budget.

All green: nothing on stdout, one `health` record appended to
`~/.claude/skill-runs/router.jsonl`, one `health` line in the log. Any failure:
one line of context into the session naming each failed check with its reason,
and the same list in the record. The repair is `/skill-router install`, run
deliberately; a hook never rewrites `settings.json` mid-session, and a settings
change only takes effect in a new session anyway.

```bash
node ~/claude-skills/router/selfcheck.mjs --cli   # the same six checks as a table, exit 1 on failure
```

`SKILL_ROUTER_SELFCHECK=0` switches it off for a session. Like every other hook
it exits 0 no matter what happens inside it: the worst a broken self-check can do
is fail to warn you.

## Weekly review (report.mjs, /skill-review)

`report.mjs` is the deterministic half of the review. It reads every buffer,
keeps the lines inside the window, and prints one report.

```bash
node ~/claude-skills/router/report.mjs                                  # markdown, since the last review
node ~/claude-skills/router/report.mjs --since 2026-08-25T00:00:00Z --json
node ~/claude-skills/router/report.mjs --mark                           # close the window, print nothing else
```

The window runs from the `last` timestamp in
`~/.claude/router-state/review-watermark.json`, else the last seven days;
`--since` overrides both. `--mark` writes the watermark to now and prints the one
it replaced, so the next review starts where this one stopped.

Per skill: invokes by trigger; reminders by rule with the conversion rate (a
reminder the skill actually followed in the same session) and the excerpts of the
ones that converted nothing; runs by verdict, version, per-gate status and summed
numeric outcomes, with what they caught; gate decisions by reason, plus the deny
to allow cycle (how often, how stale the marker was when the gate finally took
it, how many denies it took); annotations; and the self-check history.

`Candidates` are threshold crossings, not opinions:

| kind | when it fires |
|---|---|
| `rule-never-converts` | a rule reminded 3+ times and the skill never ran after it |
| `gate-loop` | a session was denied 3+ times with no run of the skill the gate asked for |
| `self-echo` | a reminder fired on a prompt that already was that skill's slash command |
| `pattern-unused` | a `prompt` pattern matched nothing all window |
| `version-regression` | a skill version came back `not-safe` more often than `safe` |

`/skill-review` is the human half: it runs the self-check, reads this report,
turns it into a judgment and a list of proposed edits, and files the window into
Kyoung's knowledge graph. It proposes; it never edits a skill or this rule table
on its own.

## Reading it back (status.mjs)

```bash
node ~/claude-skills/router/status.mjs --md
node ~/claude-skills/router/status.mjs --json --cwd ~/portfolio-html --log 20
```

The read-only console behind `/skill-router status`. It writes nothing at all,
not even a directory, and reports: each of the four hook entries found or
missing, with the checkout it actually runs from (the failure mode a bare "the
hooks are in the file" check misses); the expected allow rules, present or not,
with other `Skill(...)` allows counted separately; the rule table row by row;
this repo's name from the common git dir, whether a `pre-commit` rule covers it,
and its marker with the marker's age; the log tail across the rotated file; the
record files by type; and the last self-check. It always prints the caveat that
hooks are captured at session start, because from inside a process there is no
way to tell whether the session predates the settings file.

## Files and knobs

- `~/.claude/router-state/<session_id>.json`: session ledger (reminders sent, skills
  run, typed invocations). Hooks can overlap on parallel tool calls, so a save
  re-reads the file and merges rather than overwriting. Pruned after 7 days.
- `~/.claude/router-state/router.log`: one tab-separated line per decision, six
  columns (timestamp, event, rule id, repo, decision, detail), rotated to
  `router.log.1` at 1 MB.
- `~/.claude/router-state/review-watermark.json`: `{"last": "<ISO>"}`, where the
  last weekly review stopped. Written only by `report.mjs --mark`.
- `~/.claude/skill-runs/router.jsonl`: the `health` records the session self-check
  writes. It is the router's own buffer, not a skill's.
- Env: `ROUTER_STATE_DIR`, `SKILL_RUNS_DIR`, `ROUTER_RULES` override the locations
  above and the rule file. The tests point the first two at temp directories, and the
  third at a temp rules file whenever a case needs a different table.
  `SKILL_ROUTER_SELFCHECK=0` skips the session self-check; `SKILL_ROUTER_PROBE=1`
  marks a process as one of its probes, which also skips it.
- Every hook script exits 0 no matter what happens inside it. A bug can only switch
  the router off; it cannot break a session. A missing or unparseable rules file logs
  `rules-load-failed` and lets the call through. The test suite is the canary.

## Tests

```bash
cd ~/claude-skills && node --test 'router/test/*.test.mjs'
```

Quote the glob so Node expands it. The bare directory form (`node --test
router/test/`) is read as a module path on Node 22, so it fails without running any
of them. Fixture tests pipe hook JSON into each script against temp git repos and
temp state directories, with `HOME` redirected too, so a run never touches your real
`~/.claude`.

`test/probe-settings.json` plus `probe.mjs` log raw hook payloads from a real
session, which is how the `pretooluse_context` question gets answered for a given
Claude Code version. The settings file hard-codes my checkout, so edit its three
`command` paths to point at yours before using it:

```bash
claude -p --settings ~/claude-skills/router/test/probe-settings.json --allowedTools "Bash(echo:*)" "run: echo hi"
cat ~/.claude/router-state/probe.log
```

# router

Hooks that make the skills in this repo fire at the right moment, plus a local
record of every run so the skills can be improved from evidence later.

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
- **run records.** Every invocation is logged with how it was triggered (typed by
  you, suggested by the router, or picked by the model), every skill appends its
  outcome when it finishes, and `debrief` can append what a run missed. One JSONL
  file per skill in `~/.claude/skill-runs/`. Nothing is written into any repo.

## Install

```bash
node ~/claude-skills/router/install.mjs             # merge into ~/.claude/settings.json (backup first)
node ~/claude-skills/router/install.mjs --dry-run   # print the changes without writing them
node ~/claude-skills/router/install.mjs --uninstall
```

Requirements: Node 22+, git. No npm packages. The installer registers three hooks,
each with a 5 second timeout:

| Event | Matcher | Script |
|---|---|---|
| `UserPromptSubmit` | (none, so every prompt) | `on-prompt.mjs` |
| `PreToolUse` | `Bash\|Write` | `pre-tool.mjs` |
| `PostToolUse` | `Skill` | `post-skill.mjs` |

It also adds `Skill(verify)` and `Skill(reuse-scout)` to `permissions.allow` (that
list comes from `allow_skills` in `skill-rules.json`: a skill with `allowed-tools`
otherwise stops at a permission prompt, which auto-denies in non-interactive runs),
and sets `env.SKILL_RUNS_DIR` to `~/.claude/skill-runs`.

Every write is idempotent, so a second run prints `router: nothing to change`, and
the existing settings file is copied to `settings.json.bak-<timestamp>` before
anything is written. `--settings <path>` points all of it at another settings file,
which is how the tests drive it. After installing, run the suite once
([Tests](#tests)): all green means the hook I/O still matches this Claude Code
version.

## The rule table

`skill-rules.json` is the only place policy lives. The scripts are generic.

```json
{
  "repo_groups": { "web": ["portfolio-html"], "corp": ["corp-app"] },
  "docs_only": "\\.(md|mdx|txt)$|(^|/)(docs|_meta|raw)/",
  "pretooluse_context": "additionalContext",
  "track_skills": ["verify", "reuse-scout", "save-memory", "explain-diff"],
  "allow_skills": ["verify", "reuse-scout"],
  "rules": [ { "id": "...", "skill": "...", "event": "prompt | pre-commit | new-file", "repos": "web | corp | * | [\"name\"]", "mode": "block | remind", "once_per_session": true, "unless_ran": "reuse-scout", "patterns": ["regex"], "paths": ["regex"], "message": "..." } ]
}
```

- `track_skills` extends the set of skills the hooks recognize and write `invoke`
  records for; every skill named by a rule is already in it. `allow_skills` is what
  the installer turns into `permissions.allow` entries. `docs_only` is matched
  case-insensitively against each path a commit would carry.
- `repos` is a group name, `*`, or an explicit list of repository directory names
  (the basename of `git rev-parse --show-toplevel`). Outside a git repo only `*`
  rules apply.
- `event: prompt` matches `patterns` (case-insensitive, Unicode) against the first
  4000 characters of the prompt. `event: new-file` matches `paths` against the
  repo-relative path of a file that does not exist yet (the `Write` tool's
  `file_path`, or a Bash `>` / `>>` / `tee` target). `event: pre-commit` fires on a
  `git commit` in a Bash command.
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
worse than no reminder. The English verbs and nouns are word-bounded, `build` is
guarded so "the build is broken" does not match, `추가` does not match `추가로`, and
`마감` does not match `마감일`.

### Adding a rule

Add one object to `rules`, run the suite, and add a test sentence to
`test/rules.test.mjs` for each new pattern: one that must match and one near miss
that must not. No script changes are needed.

## The verify gate in detail

1. `pre-tool.mjs` sees a Bash command segment that starts with `git commit` (also
   inside `&&` chains, behind `env FOO=1`, with `-C <path>`, with `--amend`). It has
   to start the segment, so `echo "git commit"` is not a commit.
2. It resolves the repo the command itself targets: `git -C <path>`, or a preceding
   `cd <path>` in the same command, falling back to the hook's own cwd when that
   base cannot be resolved. No `pre-commit` block rule in scope means allow,
   silently.
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
change class, the file modes, and the git blob hash of every changed or untracked
file. So it is content-based (a same-length edit still moves it), mode-aware (a
`chmod` on an already dirty file moves it), and staging-neutral: running `/verify`,
then `git add`, then committing stays valid, while any actual edit in between does
not. It fails closed. If any git call fails the fingerprint is unavailable and the
gate denies with `fingerprint unavailable (git failed)` rather than passing on a
hash computed over less than the whole tree.

`/verify` writes the marker through `skills/verify/references/mark-pass.mjs` (a shim
over `router/mark-pass.mjs`) only when its verdict is safe, and clears it otherwise:

```bash
node router/mark-pass.mjs --root <repo> --gates '{"git":"PASS","typecheck":"PASS","tests":"PASS","screenshots":"PASS"}' --routes '["/","/work/x"]'
node router/mark-pass.mjs --root <repo> --clear
```

`--routes` is a JSON array, and a malformed one is an error rather than a null
field, because the marker is the record of what `/verify` actually ran. The
failures it reports, each meaning no marker was written: `not-a-git-repo`,
`bad-gates-json`, `bad-routes-json`, `fingerprint-failed`, `marker-write-failed`.

## Run records

`~/.claude/skill-runs/<skill>.jsonl`, one JSON object per line, three types:

```json
{"type":"invoke","repo":"portfolio-html","session_id":"...","prompt_id":"...","trigger":"user","id":"verify-20260831T233001Z-3f2a","ts":"2026-08-31T19:30:01-04:00","skill":"verify"}
{"type":"run","version":"1.1.0","repo":"portfolio-html","cwd":"/.../web","session_id":"...","session_inferred":true,"outcome":{"verdict":"safe","gates":{"git":"PASS","typecheck":"PASS","tests":"PASS","screenshots":"PASS"},"tiles":9,"routes":["/"],"duration_s":84},"caught":[],"id":"verify-20260831T233105Z-9c1d","ts":"...","skill":"verify"}
{"type":"annotation","ref":"verify-20260831T233105Z-9c1d","repo":"portfolio-html","missed":"carousel mobile overflow","by":"debrief 2026-09-02","note":"tiles were desktop-only","id":"verify-20260902T140000Z-77aa","ts":"...","skill":"verify"}
```

- `invoke` is written by the hooks. `trigger` is `user` (you typed the slash
  command, written by the prompt hook), `router` (a reminder for that skill fired
  earlier in the session) or `model` (the model picked the skill on its own); the
  last two are written by the `Skill` hook, for tracked skills only.
- `run` is written by the skill itself as its last step through `record-run.mjs`.
  `version` comes from the skill's `metadata.version`, so outcomes are comparable
  per skill version. Everything in `--json` except `caught` lands under `outcome`.
  `session_id` is inferred from the newest ledger for the same repo within the last
  three hours, and `session_inferred` says whether one was found.
- `annotation` is appended later (by `debrief`) and points at a run by `ref`.
  Records are never edited in place.

```bash
node router/record-run.mjs --skill verify --cwd <repo> --json '{"verdict":"safe","gates":{"git":"PASS"},"caught":[]}'
node router/record-run.mjs --skill verify --type annotation --json '{"ref":"<run id>","missed":"...","by":"debrief 2026-09-02"}'
```

It answers with the id and the file it appended to, and it never throws: a bad call
comes back as `{"ok":false,"reason":"..."}` with `missing --skill`, `invalid --json`
or, for an annotation, `missing ref`.

## Files and knobs

- `~/.claude/router-state/<session_id>.json`: session ledger (reminders sent, skills
  run, typed invocations). Hooks can overlap on parallel tool calls, so a save
  re-reads the file and merges rather than overwriting. Pruned after 7 days.
- `~/.claude/router-state/router.log`: one tab-separated line per decision, six
  columns (timestamp, event, rule id, repo, decision, detail), rotated to
  `router.log.1` at 1 MB.
- Env: `ROUTER_STATE_DIR`, `SKILL_RUNS_DIR`, `ROUTER_RULES` override the locations
  above and the rule file. The tests point the first two at temp directories, and the
  third at a temp rules file whenever a case needs a different table.
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
Claude Code version:

```bash
claude -p --settings ~/claude-skills/router/test/probe-settings.json --allowedTools "Bash(echo:*)" "run: echo hi"
cat ~/.claude/router-state/probe.log
```

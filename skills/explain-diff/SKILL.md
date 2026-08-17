---
name: explain-diff
description: Reviews an AI-written diff hunk by hunk before you approve it. Two axes in one table, why each change exists (evidence traced, never guessed) and whether it deserves to exist (✅ keep, ✂️ cut, 🔻 trim, ❓ ask). Use for requests like "review this diff before I approve it", "is this safe to accept?", "what did you just change, does it all belong?", and right after an AI finishes a change when the user has to decide whether to keep it. Default target is the uncommitted working tree; a ref or range in the arguments scopes it to that range. Exhaustive correctness-bug review belongs to /code-review, and style cleanup plus applying it belongs to /simplify; this skill judges whether a change earned its place and stops at the report. Pass html in the arguments, or ask for an html view or a file that reads nicely, and the same review renders as a local HTML file opened in the browser.
user-invocable: true
argument-hint: "[ref/range, e.g. HEAD, main..feature/x] [html for the browser view]"
allowed-tools:
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git show:*)
  - Bash(git status:*)
  - Bash(git blame:*)
  - Bash(git merge-base:*)
  - Bash(git rev-parse:*)
  - Bash(git rev-list:*)
  - Bash(open:*)
  - Read
  - Grep
  - Glob
  - Write(//tmp/**)
  - Write(//private/tmp/**)
---

# diff review gate (explain-diff)

Review an AI-written diff hunk by hunk, so that the user's approval decision
takes a single read. There are two axes: **why it exists** (trace the evidence
and write it down with its source) and **whether it deserves to exist** (give a
verdict with its reasoning). The main target is AI work the user has not
approved yet.

Boundaries with the neighbouring tools:
- `/code-review` = is this **wrong** (exhaustive correctness bugs). Not done here.
- `/simplify` = make it **cleaner** (style and structure, applied). Not done here.
- This skill = **why is it here, and should it be.** It stops at the report. A
  gate that deletes first is not a gate. Fixes come afterwards as ordinary
  edits, once the user has seen the verdicts and said so.

Write every piece of prose you produce (table cells, rationale, the one-line
report, the HTML text) in the language the user is prompting in. Keep
identifiers, paths, and code as they are.

## 1. Resolving the scope

- If the argument contains `..` (`main..feature/x`), use it as the range as given.
- A single ref without `..` means **that one commit**, so normalize it to
  `<ref>~1..<ref>`. (What `git diff HEAD` returns is not the content of that
  commit, it is the difference against the working tree. Skip the normalization
  and the thing you review is not the thing you were asked about.) For a first
  commit that has no `<ref>~1`, read it with `git show <ref>`.
- With no argument, **start from the working tree.** If `git status --short`
  prints even one line, that is the scope. Untracked files marked `??` are
  inside it too (a file the AI just created is usually there). Use
  `git diff HEAD --stat` only to gauge the size, and never skip the working
  tree because that command came back empty. This skill is mostly used for
  "what the AI just did", so this is the default.
- If the working tree is clean, promote the scope to the branch range. Look for
  a base candidate in this order, main, then master, then
  `git rev-parse --abbrev-ref origin/HEAD`, then origin/main, then
  origin/master; with the first one that resolves, run
  `git merge-base <base> HEAD` and use `<merge-base>..HEAD`.
- Count with `git rev-list --count <range>` and **do not start if the range is
  over 20 commits.** Report the range, the commit count, and the file count in
  one line, offer candidates for narrowing it (the latest commit only, one
  specific file), then wait for an answer.
- If there is nothing to review, say so in one line and stop. Do not
  manufacture findings.
- Name the scope you settled on in the first line of the output, and show it
  when you normalized (for example, `HEAD → 7c4be10~1..7c4be10`).

## 2. Collecting

The map comes first. For a commit range that is `git diff --stat -M <range>` plus `git log --oneline <range>`; in working-tree mode the map is `git status --short` plus `git diff HEAD --stat`.
Then read **file by file only**: `git diff -M <range> -- <path>`. Do not
swallow the whole diff in one go. As the volume grows you lose track of which
hunk was what.

- Untracked files do not show up in `git diff`. Read the content with
  `git diff --no-index /dev/null <path>` or with Read, and put it in the table
  as one row like any other change. If an untracked file is a lock or generated file, do not open it; the rule below applies instead.
- Lock and generated files (`*.lock`, `package-lock.json`, build output) are
  not read. They get one table row.
- When the same pattern repeats across several files, group it into one row
  with one verdict. List only the two or three most notable paths.
- For a hunk whose intent is not clear from the diff alone, do not guess. Open
  the file and look at the callers, the signature, and the tests that came with
  it before judging.

## 3. The evidence ladder, the "why" axis

Why a change exists is not invented, it is **dug up**. Search in this order:

1. **This session's conversation.** What did the user ask for, and out of which
   failure or context did this change come. This is the primary evidence.
2. **The document the session was following.** A plan file, a task spec, a
   TASKS.md item.
3. **The commit message**, if the range is already committed. If it says
   `fix:`, what the original symptom was.
4. **Tests that changed alongside it.** Did a test demand this change.
5. **Repo conventions.** Does CLAUDE.md, AGENTS.md, or the README require it.

Rules:
- When you cannot find it, **write "no evidence found", which is itself a
  verdict signal.** Inventing a plausible reason is this skill's worst failure.
- Trace two steps deep at most (the changed file, then what it directly calls
  or is called by, then stop). Anything that needs more digging to confirm does
  not get confirmed, it drops to ❓.
- When the diff comes from another session and there is no conversational
  evidence, **say so in the second line of the output** and proceed with
  sources 2 through 5. Confidence drops and the ❓ count rises; that is the
  honest behaviour.

## 4. The verdict, the "should it exist" axis

Every row gets exactly one:

- **✅ keep.** Directly tied to the request, and the evidence is clear.
- **✂️ cut.** Unrelated to the request, or slop. Only **when you can argue that
  deleting it leaves the requested behaviour intact.** If you cannot make that
  argument, downgrade it to ❓.
- **🔻 trim.** Right direction, too much of it. Offer the smaller form in one
  line (for example, "three nested try/catch, one at the top level is enough").
- **❓ ask.** If your confidence (self-scored 1 to 10) is 7 or lower, do not
  give a verdict. Write the one line you would ask the user instead.

Slop signals that call for ✂️ or 🔻:
- Tracing failed across the whole evidence ladder. "A change nobody asked for"
  is a cut candidate by default
- Comments restating what the code already says
- Defensive code on a trusted path (unnecessary try/catch, null checks)
- Refactors, renames, and blanket style changes nobody asked for (diff padding)
- A helper or abstraction with no callers, or with exactly one
- Scope creep, changes reaching into files unrelated to the task
- Unnecessary logs, dead code, unused imports

Forbidden, and kept separate:
- Do not touch code style that is a matter of taste. That belongs to `/simplify`.
- If a correctness **bug** catches your eye during the review, keep it off the
  verdict axis: report at most 3 of them as "suspected bugs" and say to take
  them to `/code-review`. When they compete for those slots, **a defect this
  diff just created comes before a pre-existing one.**
- No verdicts to fill space. If there are zero ✂️, write zero. Manufacturing a
  cut for a change that was in fact worth committing is the second worst
  failure.

## 5. Output format

````markdown
`<range>` (N files, +X −Y) · <one sentence on the whole thing> · verdict: ✅a ✂️b 🔻c ❓d
<one line for anything unusual, for example, no conversational evidence, judged from commit messages. Omit when there is none>

| # | hunk | what | why, and the evidence source | verdict |
|---|------|------|------------------------------|---------|
| 1 | api.ts:42 | adds 3 retries | conversation, user asked to "handle the flaky network" | ✅ |
| 2 | api.ts:88 | wraps it in try/catch | no evidence found, defensive addition | ✂️ |

### Detail, non-keep rows only
#### 2. api.ts:88, try/catch
```diff
<3 to 12 lines, the core excerpt>
```
- Why it can go: <the argument that deleting it preserves the requested behaviour> · check by: <command to run, or the place to open>

### ❓ Questions (only when there are any)
- <one line per question>

### Suspected bugs (only when there are any, max 3)
- `path:line` <one sentence> → `/code-review` recommended

### Next action
Say "cut the ✂️ ones" or "just cut number 2" and it gets applied.
````

- A row in the table is a **logical unit of change**, not a physical hunk. One
  rename that produces 12 hunks is one row.
- If everything is ✅, finish with the table plus one line, **"no slop, safe to
  approve"**. Skip the detail section.
- Quote hunk code in the detail section only, 3 to 12 lines. Pasting the whole
  diff back is waste. The user gets the original with one `git diff`.
- Locations are written `path:line`, without exception. It has to be a form the
  user can open on the spot. A whole new file is written `path:1-N` (its full
  line range).

## 6. html mode (opt-in)

When the arguments contain `html`, or the user asks for an html or file view,
complete the same review as in §1 through §4, then render it as a **GitHub-style
split diff** (left = before, right = after, changed lines highlighted). Every
file gets a blue "what this means" box above its diff. The script does the
rendering, the review does the writing.

1. Write the config JSON to `<output path>.config.json`. The schema is defined
   by the header comment of `references/gen-splitdiff.js`. The key fields:
   `sections[]` (range groups, one per PR or per commit), `subtitle` (put the
   verdict-count line from §5 here), `notes["<sectionId>:<file path>"]` (the
   HTML explaining what that file's change means).
2. **Rules for writing notes. Someone who did not sit through the session
   reads this.** The shape of each note: (1) what changed and how (plain
   language, only code identifiers in `<code>`), (2) why it changed (what the
   evidence ladder in §3 dug up), (3) what was verified and what was not
   (anything unverified, every non-keep verdict, and every open question comes
   with ⚠️). Do not use abbreviations or nicknames coined in this session or
   conversation. If the concept is needed, spell it out. Ticket numbers
   (for example, ABC-123), commit shas, and real code names are written as they
   are. Note
   values are rendered as HTML, so a component name written with bare angle
   brackets like `<Name>` gets swallowed as a tag and disappears: put it in
   `<code>` or escape it as `&lt;`. The same goes for the other two characters
   the parser owns, `>` and `&`, which become `&gt;` and `&amp;`. A JSX or HTML
   excerpt pasted raw breaks the view.
3. Run `node <skill directory>/references/gen-splitdiff.js <config> <output path>`,
   then **check the `notes: n/m matched` count the script prints.** If UNUSED
   NOTE KEYS appears, a typo in a path silently dropped a note, so fix it and
   re-run. If it is clean, `open <output path>`. The output path is
   `/tmp/<YYYY-MM-DD>-explain-diff-<repo name>.html`, and if that name already
   exists (check with Glob), add `-2`, `-3`, and so on before the extension,
   like `<repo name>-2.html`. The script's output is offline and
   self-contained. Do not add external requests (CDN, fonts, remote images) to it.
4. Keep this mode's terminal output to three lines: the first line of §5 (the
   range plus verdict counts), the path of the file you wrote, and the one-line
   next action. The HTML carries the full text. The file path is in the HTML,
   so a follow-up like "why is this file like this?" still works.

If `html` is absent, ignore this section entirely and write no file.

<!-- Scope normalization, the evidence ladder, and the trace-depth cap originate in yuyeol3/explain-diff (MIT) -->

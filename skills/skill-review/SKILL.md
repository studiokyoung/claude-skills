---
name: skill-review
description: The weekly reinforcement ritual for the skills and the router behind them (Fridays). Use for "/skill-review", "주간 리뷰", "how are the skills doing", "are the reminders actually working", "which rule keeps firing for nothing", "did the gate help this week", "review the run records". Proves the router still fires (self-check), aggregates the week's records into one deterministic report, reads it into a judgment per skill, proposes the SKILL.md and rule-table edits the numbers argue for, and files the week into Kyoung's knowledge graph as tool nodes. Never edits a skill or a rule without an explicit yes. Not the operator console (/skill-router: status, log, install), not the tacit-knowledge pass (debrief), not source ingestion (/ingest).
user-invocable: true
argument-hint: "[since <ISO>] [dry]"
metadata:
  version: "1.0.0"
allowed-tools:
  - Bash(node ~/claude-skills/router/selfcheck.mjs --cli:*)
  - Bash(node /Users/kyounghoonkim/claude-skills/router/selfcheck.mjs --cli:*)
  - Bash(node ~/claude-skills/router/report.mjs:*)
  - Bash(node /Users/kyounghoonkim/claude-skills/router/report.mjs:*)
  - Bash(cat:*)
  - Bash(tail:*)
  - Bash(ls:*)
  - Bash(grep:*)
  - Bash(wc:*)
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(git diff:*)
  - Read
  - Grep
  - Glob
  - Write(/Users/kyounghoonkim/Self-GraphDB/raw/skill-runs/**)
  - Write(/Users/kyounghoonkim/Self-GraphDB/graph/projects/**)
  - Edit
---

# skill review (the Friday ritual)

The router records every reminder, every gate decision and every run, and none
of that becomes a better skill on its own. This is the hour where the week's
records turn into edits: which reminder converted, which rule fired for nothing,
which gate stood in the way three times before anybody ran `/verify`, and which
version of a skill caught less than the one before it.

Human-triggered on purpose. Detection is automatic (the self-check runs at every
session start); reinforcement is a decision Kyoung makes, once a week, looking at
numbers.

**The prime directive: every number you say comes from the report you just ran.**
Not from memory of last week, not from a file you skimmed. If the report does
not carry it, you do not claim it. The whole point of the record layer is that
it cannot be flattered.

Write the prose in the language Kyoung is prompting in. Keep skill names, rule
ids, JSON keys, file paths and the report's own numbers as they are.

## 0. Arguments

| argument | effect |
|---|---|
| (none) | window = since the last review's watermark, else the last 7 days |
| `since <ISO>` | passed straight to `report.mjs --since <ISO>` |
| `dry` | run §1 to §3 and stop: no graph writes, no watermark, no commit |

## 1. Is the router even on

```
node ~/claude-skills/router/selfcheck.mjs --cli
```

Six checks, printed as a table: the four hooks are registered from this
checkout, the rule table parses, and each hook still fires when handed a real
payload against throwaway directories.

- **PASS** → say so in one line and continue.
- **FAIL** → **stop here.** Print the failing rows verbatim and say that the
  week's report cannot be trusted for the period the router was broken: a hook
  that was not running left no records, and missing records read as "quiet
  week", which is the exact wrong conclusion. The repair is
  `/skill-router install`, and it needs a new session before it takes effect.
  Offer to run the review anyway only if Kyoung asks, and label the report as
  covering a period with a known gap.

## 2. Read the report

```
node ~/claude-skills/router/report.mjs --md
```

Read it **whole** before writing a word of judgment. It is deterministic: the
same records give the same report, so anything surprising in it is a fact about
the week, not about the run.

What the sections mean:

| section | the question it answers |
|---|---|
| `invoke` by trigger | did **you** reach for the skill (`user`), did the router (`router`), or did the model pick it (`model`)? A skill only ever invoked by the router is one the habit has not formed for. |
| `remind` + conversion | of the reminders delivered, how many were followed in the same session. The unconverted excerpts are the wording that produced a reminder nobody wanted. |
| `run` by verdict / version | what the skill concluded when it finished, and whether a version change moved it. `invoke` without a matching `run` is a skill that started and quit. |
| `gates.<name>` | for `verify`, which of its own gates pass, fail and get skipped. A gate that is always SKIP is not covering anything. |
| `gate` allow/deny + cycles | the commit gate. `deny to allow cycles` is the real cost of the gate: how many denies it took, and how stale the marker was when it finally passed. |
| `annotation` | what a run **missed**, added later by `debrief`. The only honest measure of whether a skill is getting better. |
| `Candidates` | the deterministic proposals: threshold crossings, not opinions. |
| `Health` | the self-check history. Failures here date the gaps in every other number. |

If the window is empty, the report says so. That is a finding: either the week
was quiet or the router was off, and §1 already said which. Do not manufacture a
review out of nothing.

## 3. Judgment, per skill

For each skill with records this window, two sentences of reading, then the
candidate edits. Keep it tight; this is the part Kyoung actually reads.

````markdown
### verify · 12 invokes (8 user / 1 router / 3 model) · 9 runs · 21 gate decisions
Kyoung reaches for it himself most of the time, and the gate is doing the rest:
3 deny-to-allow cycles, median marker age 96s. Two runs came back not-safe and
both were typecheck, which is the gate earning its keep.

**Candidates**
| # | edit | file | why (from the report) |
|---|------|------|------------------------|
| 1 | drop pattern #1 of `reuse-scout-prompt` | `router/skill-rules.json` | 0 matches this window, 3 reminders all from pattern #0 |
| 2 | say the screenshots gate must not be SKIP twice running | `skills/verify/SKILL.md` | `gates.screenshots` SKIP 6 of 9 runs |
````

Rules for this section:

- Every "why" cell quotes a number from the report. No cell says "feels like".
- A candidate the report produced but you disagree with is listed with your
  reason for not proposing it, rather than dropped silently.
- **You do not edit any SKILL.md or `skill-rules.json` here.** Propose, wait for
  an explicit yes, and let the edit happen as a normal change that the router's
  own suite then covers (`cd ~/claude-skills && node --test 'router/test/*.test.mjs'`).
  A rule-table edit also needs a matching sentence and a near-miss in
  `router/test/rules.test.mjs`.

## 4. File the week into the graph

Skip entirely on `dry`. This skill is **the only writer into the graph for the
skill layer**, by decision: the buffers are the raw material, the nodes are the
distilled wiki over them. Everything below happens in
`/Users/kyounghoonkim/Self-GraphDB`.

**4a. Raw.** Append this window's new record lines to
`raw/skill-runs/<skill>.jsonl`, one file per skill, **deduped by `id`**:

```
ls ~/Self-GraphDB/raw/skill-runs/ 2>/dev/null
grep -o '"id":"[^"]*"' ~/Self-GraphDB/raw/skill-runs/<skill>.jsonl | sort
cat ~/.claude/skill-runs/<skill>.jsonl
```

Take the lines whose `ts` is inside the report's window and whose `id` is not
already in the destination, and write the destination as the old lines plus
those, byte for byte as they came. `raw/` is immutable source material: never
rewrite or reformat a line that is already there.

**4b. One node per tracked skill**, at `graph/projects/<skill>-skill.md`. Create
it if missing, refresh it if it exists:

```markdown
---
id: verify-skill
type: project
visibility: private
updated: 2026-09-04
edges:
  part_of: [claude-skills]
---

## 현재 상태 (as-of 2026-09-04)

- 이번 창(8/29~9/4): invoke 12 (user 8 · router 1 · model 3) · run 9 · gate 21
- 전환: 리마인드 0 (게이트형이라 리마인드 룰 없음)
- 게이트: deny→allow 사이클 3 · 마커 중앙값 96s · docs-only allow 5
- 잡은 것 4 / 놓친 것 1 (`annotation.missed`: carousel mobile overflow)
- 버전 1.1.0 — safe 7 / not-safe 2
- 열린 후보: screenshots 게이트 SKIP 6/9 (§3 후보 2)

*(이 블록만 제자리 개정 — 아래 절들은 append-only 히스토리.)*

## 강화 이력

- **2026-09-04** — 첫 리뷰. …
```

The `현재 상태` block is rewritten in place every review; `강화 이력` gets one
dated bullet appended and nothing below it is ever edited. Both conventions come
from that repo's `CLAUDE.md`; read it if anything here is ambiguous.

**4c. The hub**, `graph/projects/claude-skills.md`, once: what the repo is, which
skills live in it, that the router is the enforcement layer, and a link to each
skill node. It carries a `현재 상태` block too (hub nodes always do), refreshed
each review with the totals line.

**4d. `INDEX.md`** gets one line under `## projects` for each node you created,
in the existing format: `- [id](graph/projects/id.md) — <one-line hook>`.

**4e. `log.md`** gets one appended entry:

```
## [2026-09-04] maintain | **skill-review 주간 — <the week in one clause>** <numbers, candidates, what was decided>
```

**4f. Show, then ask.** Print `git status --short`, list what you touched, and
**ask before committing.** On yes, stage by path (never `git add -A`: other
sessions work in that repo), and end the message with that repo's two trailer
lines. Never push.

## 5. Mark the window

Only after §4 is committed, or after Kyoung says the review is done:

```
node ~/claude-skills/router/report.mjs --mark
```

It prints the new watermark and the one it replaced. The next review starts
there, so marking a window you did not actually review is how a week goes
unexamined forever. On `dry`, do not mark.

## 6. Misses go to debrief

If the report's `annotation` lines carry any `missed`, or Kyoung names something
a skill should have caught this week, that is not a candidate edit yet: it is
tacit knowledge that has not been extracted. Hand off to `debrief` ⑤ and say so
in one line. A miss recorded and never debriefed is the failure this whole loop
exists to prevent.

## Boundaries

| Tool | Question it answers |
|---|---|
| `/skill-router` | Is the router **on**, what did it decide, and how do I install or remove it? |
| `/skill-review` | Are the skills **getting better**, and what should change this week? |
| `debrief` | What did that miss **teach**? (writes the annotations this review reads) |
| `/ingest` | Absorbing an external **source** into the graph. Not this. |

This skill reads records and writes tool nodes. It never runs a gate, never
edits a skill or the rule table on its own, and never writes a claim about
Kyoung: these nodes are about the tools, and the person they belong to is
already the rest of the graph.

## Verification (self-check before you report — mandatory)

- Did `selfcheck.mjs --cli` actually run in this turn, and does the report say
  PASS or FAIL because of what it printed?
- Is every number in the judgment traceable to a line of the report you ran? Any
  number you cannot point at gets deleted, not softened.
- Did you propose the SKILL.md / rule-table edits rather than making them, and is
  every candidate backed by a count from the report?
- For the graph writes: is each `raw/skill-runs/` line byte-identical to the
  buffer it came from, deduped by `id`? Was the `현재 상태` block replaced in
  place and `강화 이력` only appended to?
- Does every node say something about a **tool**, with no claim about Kyoung
  written in your own words?
- Was `git status` shown and an explicit yes given before the commit, with
  path-specified staging and no push?
- Was `--mark` run only after the review was actually finished (and never on
  `dry`)?

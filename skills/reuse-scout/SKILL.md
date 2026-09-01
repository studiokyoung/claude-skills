---
name: reuse-scout
description: Pre-flight reuse scan to run BEFORE writing any new component, hook, util, or feature — inventories what the current repo ALREADY has so you extend it instead of reinventing it (AI's #1 way to ship a duplicate, buggy twin of existing code). Parses the ask into capabilities, greps components/hooks/lib/modules/app plus design tokens for real analogs by name AND behavior, and emits a REUSE MANIFEST — per capability a candidate file:line + signature + verdict (✅ reuse / 🔶 partial / ❌ genuinely new), naming the canonical impl when twins exist. Every file:line is a verified grep hit, no fabricated matches. Triggers on "build/add/create a … component/hook/util", before superpowers:brainstorming designs HOW. Not a diff gate (/explain-diff) or a bug review (/code-review).
user-invocable: true
argument-hint: "<feature/component to build> [write → save REUSE_MANIFEST.md]"
metadata:
  version: "1.1.0"
allowed-tools:
  - Bash(rg:*)
  - Bash(grep:*)
  - Bash(find:*)
  - Bash(git grep:*)
  - Bash(git ls-files:*)
  - Bash(node:*)
  - Read
  - Glob
  - Grep
  - Write(**/REUSE_MANIFEST.md)
---

# reuse scout — the pre-flight before you build

Run this **before** implementing anything. The failure it exists to stop: the
builder writes a new component / hook / util that the repo already has, and
ships a duplicate twin carrying its own fresh bugs. The scan produces a **reuse
manifest** — a per-capability inventory of what already exists — and the builder
must cite it: new code is allowed only where the manifest shows no match.

The stance is **"it probably already exists — prove it doesn't."** Reinvention
should be the thing you have to argue for, not the default you fall into.

Boundaries with the neighbouring tools:
- **superpowers:brainstorming** designs *how* to build the thing. It runs
  **after** this — this scan hands it the list of what to extend vs. build new.
- `/code-review` = is the written code **wrong**. After.
- `/explain-diff` = should this diff **exist**. After.
- This skill = **what already exists that I must extend instead of rewrite.**
  First. It stops at the manifest; it does not write feature code.

Write every piece of prose (table cells, the plan line, the manifest file) in
the language the user is prompting in. Keep identifiers, paths, and code as-is.

## 1. Parse the ask into capabilities

Break the one-line ask into the discrete **capabilities** it needs. A capability
is one reusable behavior, the size of a component or a hook — not the whole
feature and not a single line.

> "a keyboard-avoiding footer with a confirm button" →
> {keyboard avoidance, footer / bottom-bar layout, primary button, safe-area inset}

List them before searching. The manifest has **exactly one row per capability**.

## 2. Detect the stack and the search roots

- **Stack** — read `package.json` (or `go.mod`, `Cargo.toml`, …): `react-native`
  → RN; `next` → Next; `react` alone → React SPA; else generic TS/JS. The stack
  fixes the search vocabulary (RN: `KeyboardAvoidingView`, `useSafeAreaInsets`;
  web: `position: sticky/fixed`, `env(safe-area-inset-*)`).
- **Roots** — find which of these exist and scan the ones that do:
  `components/`, `src/components/`, `app/`, `hooks/`, `src/hooks/`, `lib/`,
  `src/lib/`, `utils/`, `modules/`, `packages/*/` (monorepo). Plus **design
  tokens**: `**/theme.css`, `**/*tokens*`, `tailwind.config.*`,
  `**/design-tokens/**`. Name the roots you actually searched in the manifest
  header — an absent root is fine; silently skipping a present one is not.

## 3. Scan — by name AND by behavior, and verify every hit

For each capability, two passes, then confirm:

- **a. Name pass** — files and exported symbols whose name matches the
  capability. `rg --files <roots> | rg -i '<term>'`, and
  `rg -n -e 'export .*(function|const|class|default) .*<Term>' <roots>`.
- **b. Behavior pass** — the identifiers that betray the behavior even when the
  thing is named differently: props, hook names, CSS classes / tokens, SDK
  calls. Adapt the terms to the ask and the stack (footer → `sticky|fixed`,
  `bottom`, `inset`; safe-area → `safe-area|insets|SafeArea`).
- **c. Confirm** — open the top candidates with Read, capture the **real**
  signature / props, and check the behavior actually matches the capability.

**The anti-fabrication rule — this skill's worst failure.** Every `file:line`
you list must be a line an `rg`/`grep` actually **printed in this run**, copied
from the output — never reconstructed from memory. A cited location that does
not exist is worse than a missed match. If a capability comes up empty after a
second, looser search, it is ❌ — never a plausible-looking guess.

**Canonical implementation.** When a capability has 2+ real implementations
(twins), name which one is **canonical** — most-imported
(`rg -c "import .*<Name>" <roots>`), living in a shared dir rather than a feature
silo, newest / most-referenced — and flag the rest as *"duplicate — don't add a
third."* Naming the real one is the whole point: it's what stops the builder
cloning the wrong twin, or minting a new one beside them.

## 4. Verdict per capability

Exactly one per row:

- **✅ reuse** — an existing unit fully satisfies it. Extend it; do not rewrite.
- **🔶 partial** — an existing unit covers part of it. Reuse + extend, and say
  in one clause what's missing.
- **❌ genuinely new** — the scan found no analog; new code is justified. Only
  after **both** the name and the behavior pass came up empty.

Honesty rules: don't inflate ✅ to look thorough, and don't reach for ❌ to
justify a rewrite you already wanted. Each ❌ has to survive both passes.

## 5. Output

A compact manifest table + a one-line reuse-first plan.

````markdown
`<ask>` · stack: <detected> · roots: <dirs searched> · verdict: ✅a 🔶b ❌c

| capability | best existing match (file:line) | signature / props | canonical? | verdict |
|---|---|---|---|---|
| footer / bottom bar | components/shell/Footer.tsx:12 | (children, sticky?) | yes — imported by 8 screens | ✅ |
| safe-area inset | hooks/useSafeArea.ts:4 | () → { top, bottom } | one impl | ✅ |
| keyboard avoidance | — (no match) | — | — | ❌ |

Reuse-first plan: extend <A> + <B>; build <C> new (no analog) — <one clause how>.
````

- **One row per capability from §1 — none dropped.** A capability with no match
  still gets a row (match `—`, verdict ❌).
- `file:line` is the **definition site** (the export line), openable as-is.
- If the arguments contain a flag word (`write`, `save`, `파일`), also write the
  block to `REUSE_MANIFEST.md` at the repo root. **Default is print-only** — do
  not litter the repo.
- Keep terminal output to the header line + table + plan. The table is the
  product, not a narration of the search.

## 6. Verification — self-check before you emit

- **Coverage** — did the scan actually touch the `components/hooks/lib/utils/
  modules/app` roots *and* the token/theme files that exist? The header names
  the roots searched.
- **No fabrication** — re-confirm every `file:line` is a real hit from this run;
  **spot-re-grep two of them.** A location that doesn't resolve → stop and fix
  before emitting.
- **Canonical named** — wherever the scan found 2+ twins for one capability, the
  table says which is canonical.
- **Nothing dropped** — every §1 capability has exactly one row and one verdict.
- **Honest verdicts** — each ❌ survived both a name and a behavior pass; no ✅
  is padding.

## 7. Record the run (after you emit — always)

One command, so the run ledger (`$SKILL_RUNS_DIR/reuse-scout.jsonl`, default
`~/.claude/skill-runs/`) sees what the scan found:

```
node <skill dir>/references/record-run.mjs --skill reuse-scout --cwd <repoRoot> --json \
  '{"ask":"<ask>","capabilities":4,"reuse":2,"partial":1,"new":1,"twins_found":1,"caught":["Footer twin at components/shell/Footer.tsx: extend, do not add a third"]}'
```

`capabilities` / `reuse` / `partial` / `new` are the manifest counts; `twins_found` counts
capabilities with 2+ real implementations; `caught` names each reuse or twin the scan
surfaced (one short clause each), `[]` when every row was ❌. Skipping this is a skill
failure: an invocation with no record is exactly how a scan that never finished looks.

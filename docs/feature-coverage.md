# Feature / requirement coverage

The source-of-truth description of the **second coverage axis** (R7.5). Keep this in
sync with the code in the same change that alters behavior. Cross-references:
[`requirements.md`](requirements.md) (the requirement index this audits),
[`manual-test-plan.md`](manual-test-plan.md) (where `manual` requirements are
verified), and the AI summaries in [`ai/`](ai/).

## 1. Why a second axis

Line/branch coverage measures the wrong thing for whole classes of bugs. **100% line
coverage proves every line *executed*** during the suite — it says nothing about
whether every documented *behavior*, or every *sequence* of behaviors, is actually
*asserted*. A bug that lives in an untested interaction or an untested **state
transition** sails through a green 100% report, because the individual lines are
still hit by isolated, from-clean-state tests. Line coverage is a **floor, not a
ceiling**.

Feature/requirement coverage is the orthogonal axis: it walks the documented
requirement list and asks, per item, *is there a test that would fail if this
behavior regressed?* Every gap is either closed with a test or consciously
classified.

## 2. The requirement index (R-EC1)

Requirements are defined across `docs/*.md` as Markdown list items whose first token
is a **bolded requirement id** — `- **R4.3** …`, `- **R-MC1 Grouping.** …`. That
anchor is the canonical definition; a prose mention (`see R-MC4`, `EBU R128`) is not
a definition and is ignored. `extractRequirementIds()` in
[`../tools/requirement-coverage.mjs`](../tools/requirement-coverage.mjs) implements
this, and `tools/check-features.mjs` unions the ids across all docs into the index.

## 3. The coverage manifest (R-EC2)

`REQUIREMENT_COVERAGE` in `tools/requirement-coverage.mjs` maps **every** documented
requirement to *how a regression would be caught*, via a `status`:

| status | meaning |
|--------|---------|
| `unit` | asserted by unit test(s); **must** list the test file(s) under `tests/` |
| `manual` | the external-tool pipeline — verified via [`manual-test-plan.md`](manual-test-plan.md) |
| `review` | prose / skill guidance, verified by human review |
| `gate` | enforced by tooling (coverage thresholds, `npm run check`, CI, release) |
| `deferred` | designed, intentionally not built yet (links the follow-up ticket) |

Marking something anything other than `unit` is a **deliberate** "not a unit test,
and here's why" decision recorded in the entry's `note`.

## 4. The report + gate (R-EC3)

- `npm run check:features` (`tools/check-features.mjs`) prints the per-status
  dashboard and **fails** (non-zero exit) if any requirement is: missing from the
  manifest (a new behavior with no coverage decision), orphaned (a manifest entry no
  longer in the docs), `unit` with no asserting test, or naming a test file that
  does not exist. It is wired into `npm run check` and CI.
- `tests/conventions.test.ts` runs the same audit inside the normal `npm test` gate,
  and additionally pins invariants line coverage can't express: the runtime
  dependency allow-list, and that every file in `vitest.config.ts` `coverage.include`
  is real (so a pure module can't silently drop out of the 100% gate).

## 5. Stateful modules & transitions (R-EC4)

Requirements for **stateful modules** (anything with modes/phases, a cache with
fallback paths, or a state machine — e.g. `src/analyzer-state.ts`'s resume/stale
paths, `tools/multicam-autocut.mjs`'s held-angle switching) must include the
*transitions between states*, not just individual operations from a clean state.
Untested transitions are the exact gap line coverage is structurally blind to; the
`analyze-code-quality` skill's behavioral audit and the transition-matrix testing
mandate in `CLAUDE.md` are the process side of the same concern.

## 6. Requirements

- **R-EC1** A canonical requirement index is derived deterministically from the
  `- **R<id>**` definitions across `docs/*.md`; prose cross-references are excluded.
- **R-EC2** A coverage manifest maps every documented requirement to a verification
  status (`unit`/`manual`/`review`/`gate`/`deferred`); `unit` entries name their
  asserting test file(s).
- **R-EC3** `check:features` + `conventions.test.ts` fail if any documented
  requirement lacks a coverage decision, is orphaned, is `unit` with no test, or
  names a non-existent test file; both run in `npm run check` / CI.
- **R-EC4** The index and manifest treat state *transitions* as first-class
  behaviors for stateful modules, not just single operations from a clean state.

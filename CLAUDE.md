<!-- hotsheet:begin section=ticket-driven-work v=1 -->
## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the `hotsheet_*` MCP tools), mark Up Next, then work through them: set status `started` → implement → set `completed` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket `completed`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket `started`, add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), signal channel done, and wait. It's the only reliable way to surface a question.
<!-- hotsheet:end section=ticket-driven-work -->

<!-- hotsheet:begin section=testing-philosophy v=2 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Coverage is a floor, not a ceiling**: 100% line/branch coverage shows every line *ran*, not that every *behavior* — or every *sequence* of behaviors — is *asserted*. It is structurally blind to a **missing state transition**: a bug living in an untested interaction sails through a green 100% report because the individual lines still get hit by isolated, single-operation tests.
- **Transition-matrix testing for stateful modules**: for anything with modes / multiple code paths / a cache / a state machine, enumerate the states AND the transitions between them, then write tests that walk realistic multi-step sequences crossing state boundaries — not just each operation from a clean initial state.
- **Adversarial pass on stateful changes**: when adding or altering a stateful code path, deliberately try to break it with out-of-order / interleaved / repeated / empty-then-refill sequences; pin any that would have failed as permanent regression tests.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup

The toolkit's core is an **external-tool pipeline** (ffmpeg, whisper, ollama, headless Chromium). That orchestration can't be unit-tested reliably, so the strategy is:

- **Unit tests** (`tests/**/*.test.ts`, `tests/**/*.test.mjs`): [Vitest](https://vitest.dev) with v8 coverage. They cover the **pure, side-effect-free logic** extracted out of the I/O modules. The authoritative list of covered modules is `vitest.config.ts` `coverage.include` (read it rather than trusting a hardcoded list here) — currently the `src/` analyzer cores (`scene-math`, `resumable-error`, `analyzer-cli`, `analyzer-state`) plus the pure `tools/*.mjs` modules (`caption-format`, `export-manifest`, `fcpxml`, `sources`, `multicam*`, `audio-events`, `wav-compat`, `transitions-render`, `visual-saliency`, `multicam-autocut`, `requirement-coverage`). Every file in `coverage.include` is held to **100% lines/branches/functions/statements** (`thresholds`). When you extract more pure logic, add it to `coverage.include` and test it to 100%.
- **Feature/requirement coverage** (the second axis, `docs/feature-coverage.md`): `tools/requirement-coverage.mjs` (pure, 100%-tested) maps every documented requirement (`- **R<id>**` across `docs/*.md`) to how a regression is caught. `npm run check:features` + `tests/conventions.test.ts` fail if any documented requirement has no coverage decision, is orphaned, or is marked `unit` without an asserting test. When you add/change a requirement, update the manifest in the same change.
- **Manual / pipeline tests**: the analyzer's ffmpeg+ollama run, the launcher (`bin/video-studio.mjs`), and `render-caption.mjs`'s Chromium render are **out of scope for automated coverage** and documented in **`docs/manual-test-plan.md`** instead. Keep that doc current; if you automate a previously-manual item, move it into a unit test and note it in the doc's "Automated Coverage Summary".
- **Commands**: lint `npm run lint` · typecheck `npm run typecheck` · unit + coverage `npm test` · feature coverage `npm run check:features` · everything `npm run check` (lint → typecheck → test → check:features → build).
- **Always** run `npm run check` before finishing a change; CI (`.github/workflows/ci.yml`) runs the same gates on push/PR.
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout

All docs live under **`docs/`** (kebab-case filenames). Layout:

- **`docs/requirements.md`** — the source-of-truth requirements (numbered `R<area>.<n>`). This is what the code must satisfy; update it in the same change that alters behavior. Add a new doc for a major new functional area and cross-link it here.
- **`docs/releasing.md`** — the release flow + npm trusted-publisher setup.
- **`docs/manual-test-plan.md`** — the manual checklist for the external-tool pipeline (see the Testing section).
- **AI summaries** (read these first in a fresh session; keep in sync, source/code wins):
  - **Codebase map** → **`docs/ai/codebase-map.md`** (tree, entry points, data shapes, build/test/lint, "where do I look for X", update triggers).
  - **Requirements summary** → **`docs/ai/requirements-summary.md`** (status dashboard: Shipped / Partial / Design only / Deferred, with follow-ups).
- **Root-level** `README.md` (human entry point) and `CHANGELOG.md` enumerate the public surface and drift the same way — update them alongside the docs.

When you add/remove a public behavior, a CLI flag, a file, or change the analyzer's state/timeline shape, update `docs/requirements.md` **and** both AI summaries in the same change. The `check-requirements-against-code` skill audits this.
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->

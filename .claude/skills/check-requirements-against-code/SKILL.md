---
name: check-requirements-against-code
description: Check video-studio's requirements docs against the implementation and keep the AI summaries + CLAUDE.md in sync
allowed-tools: Read, Grep, Glob, Bash, Agent, Edit, Write
---

Compare the requirements in `docs/requirements.md` against the actual code, and
verify the AI summary docs (`docs/ai/codebase-map.md`,
`docs/ai/requirements-summary.md`), the `README.md`, the manual test plan, and
`CLAUDE.md` are all in sync with the requirements and the code. Generate a
report with recommendations, and **make the summary-doc edits as part of this
check** (don't just report them).

## Steps

1. **Read the requirements.** `docs/requirements.md` — note every numbered
   requirement (`R<area>.<n>`). Also read `README.md` (it enumerates the public
   surface and drifts the same way).

2. **Verify each requirement against the code.** Map each `R*` to its
   implementation and confirm the behavior matches:
   - R3 (launcher) → `bin/video-studio.mjs` (flags, macOS guard, skill install +
     `{{TOOLKIT_DIR}}` substitution).
   - R4 (analyzer) → `src/analyzer.ts` (`SCENE_THRESHOLD`, the `runAnalysis`
     orchestration) + `src/ffmpeg.ts` (detection, probe, frame extraction) +
     `src/analyzer-state.ts` (resume/state keyed to path+size+mtime, atomic
     writes) + `src/resumable-error.ts` (`classifyOllamaError`) +
     `src/analyzer-cli.ts` (flags, `DEFAULT_MODEL`) + `src/ollama.ts`
     (`analyzeFrame`) + `src/scene-math.ts` (`parseFps`, `buildScenes`/
     `MIN_SCENE_SEC`, `formatTimecode`).
   - R5 (overlays) → `tools/render-caption.mjs` + `tools/caption-format.mjs`
     (styles, positions, options, validation, baked hold).
   - R6 (the skill) → `skills/video-studio/SKILL.md`.
   - R7 (quality gates) → `vitest.config.ts` thresholds + `coverage.include`,
     `eslint.config.mjs`, `package.json` scripts, `.github/workflows/`,
     `scripts/release.sh`.
   Note any `missing` / `different` / `undocumented` / `stale` discrepancy.

3. **Check for undocumented behavior.** Scan `src/`, `bin/`, `tools/` for
   observable behavior or CLI flags not covered by any `R*`. Each should either
   gain a requirement or be questioned.

4. **Check for stale requirements.** Any `R*` describing behavior the code no
   longer has.

5. **Verify `CLAUDE.md` is accurate.** Specifically the filled-in
   `specifics=testing-philosophy` and `specifics=requirements-documentation`
   blocks: the commands they list (`npm run lint/typecheck/test/check`) exist in
   `package.json`; the coverage claim (100% on the pure modules —
   `src/scene-math.ts`, `src/analyzer-cli.ts`, `src/analyzer-state.ts`,
   `src/resumable-error.ts`, `tools/caption-format.mjs`) matches
   `vitest.config.ts` `coverage.include`; the doc paths they name exist on disk.

6. **Synchronize `docs/ai/codebase-map.md`.** Confirm and edit in place:
   - The **directory tree** matches the actual tracked files (use `Glob`/`ls`).
   - **Entry points** table matches `package.json` `bin` + the tools.
   - **Data shapes** match `PersistedState`/`STATE_VERSION` (`src/analyzer-state.ts`)
     and `SceneSegment` (`src/analyzer.ts`).
   - **Build/test/lint** commands match `package.json` scripts.
   - **Settings / tuning constants** match the code (`SCENE_THRESHOLD` in
     `analyzer.ts`, `MIN_SCENE_SEC` in `scene-math.ts`, `DEFAULT_MODEL` in
     `analyzer-cli.ts`, `STATE_VERSION` in `analyzer-state.ts`, coverage config).
   - **"Where do I look for X"** entries point at files that exist.

7. **Synchronize `docs/ai/requirements-summary.md`.** Confirm and edit:
   - The **dashboard** status per area still reflects reality.
   - **Known gaps / follow-ups** still open (e.g. VS-8 `promo-assets`
     packaging) — close or update rows whose tickets have moved.

8. **Verify the manual test plan.** `docs/manual-test-plan.md` should still list
   every pipeline behavior that has no automated coverage (launcher doctor,
   analyzer resume, Ollama errors, caption render, end-to-end build). If
   something there is now unit-tested, it should be moved out and noted in the
   "Automated Coverage Summary".

9. **Final consistency pass.** Make `docs/requirements.md`, `README.md`,
   `CHANGELOG.md`, `CLAUDE.md`, and the two AI summaries agree with each other
   and with the code. Resolve disagreements in favor of the code / source doc and
   update the summaries + `CLAUDE.md` accordingly. **The most common drift in
   this project:** a new CLI flag or a changed analyzer output shape lands in the
   code but the requirements doc + codebase-map + README lag. Look for that
   explicitly.

## Report format

### Discrepancies found
Per discrepancy: **Requirement** (doc + `R*`), **Implementation** (file:line),
**Type** (`missing` / `different` / `undocumented` / `stale`),
**Recommendation** (fix the doc or the code?).

### CLAUDE.md / summary audit
- Commands named in CLAUDE.md that don't exist in `package.json`.
- Coverage claim vs `vitest.config.ts`.
- Doc paths named that don't exist on disk.
- `docs/ai/codebase-map.md` — sections edited (or "no changes needed").
- `docs/ai/requirements-summary.md` — rows edited (or "no changes needed").
- `README.md` / `CHANGELOG.md` — quick API/enumeration fixes.

### Questions
Ambiguous requirements where the implementation made a judgment call — ask
whether the current behavior is intended.

### Summary
Requirements checked / fully implemented / discrepancies by type / docs edited.

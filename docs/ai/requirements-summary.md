# Requirements Summary (AI summary)

Synthesized status view of [`../requirements.md`](../requirements.md). Status
markers: **Shipped** (built + works), **Partial** (built, gaps noted), **Design
only** (described, not built), **Deferred** (intentionally postponed). Keep in
sync with the requirements doc and code; the source wins on conflict.

## Dashboard

| Area | Requirements | Status |
|------|-------------|--------|
| Platform & deps | R2.1–R2.5 | **Shipped** |
| Launcher | R3.1–R3.7 | **Shipped** |
| Scene analyzer | R4.1–R4.8 | **Shipped** |
| Overlay generator | R5.1–R5.5 | **Shipped** |
| The skill | R6.1–R6.4 | **Shipped** |
| Quality gates | R7.1–R7.4 | **Shipped** |

Overall: the toolkit is functionally complete for its early-concept scope. The
open items below are packaging / polish, not missing core behavior.

## Per-area notes

- **Platform & dependencies (R2)** — Shipped. `bin/video-studio.mjs` enforces
  macOS, checks each tool, and offers brew installs. Claude-describes-frames is
  the default; Ollama is genuinely optional.
- **Launcher (R3)** — Shipped. All documented flags (`--check`, `--no-launch`,
  `--skills-only`, `--yes`, `--help`) implemented; skill install does the
  `{{TOOLKIT_DIR}}` substitution.
- **Scene analyzer (R4)** — Shipped. Frame-accurate detection, resumable
  state keyed to path+size+mtime, atomic writes, classified resumable errors.
  `src/analyzer.ts` is now just orchestration (149 LOC); the pure/testable logic
  is split into `src/scene-math.ts` (math), `src/analyzer-cli.ts` (arg parsing),
  `src/analyzer-state.ts` (state persistence), and `src/resumable-error.ts`
  (error classification) — all unit-tested to 100%. The ffmpeg/ollama wrappers
  live in `src/ffmpeg.ts` / `src/ollama.ts` (manual-tested).
- **Overlay generator (R5)** — Shipped. All styles/positions/options present;
  pure arg-parse + SVG/HTML assembly extracted to `tools/caption-format.mjs`
  and unit-tested to 100%; the Chromium render stays in `render-caption.mjs`.
- **The skill (R6)** — Shipped as `skills/video-studio/SKILL.md`. This is prose
  guidance for Claude rather than executable code, so it's verified by review +
  the manual test plan, not unit tests. **R6.5** (keep the AI-interpretation
  intermediates — `timeline.json` descriptions + `<dataDir>/transcripts/`) is a
  skill-guidance convention; committed examples live in `docs/samples/`
  (`tears-of-steel.scenes.json` + `.transcript.{json,txt}`).
- **Quality gates (R7)** — Shipped. Vitest 100% on the two pure modules; manual
  test plan for the pipeline; `npm run check` + CI; tag-driven release with
  provenance.

## Known gaps / follow-ups

- **`promo-assets/` packaging (VS-8) — Resolved.** The three example *sources*
  now ship via the `promo-assets/*.mjs` + `promo-assets/*.sh` globs (generated
  SVGs, the nested `node_modules`, and the nested `package.json` are excluded),
  so the `$TOOLKIT/promo-assets/*` references in `SKILL.md` resolve for
  npm-installed users. The example scripts were made portable (published
  `domotion-svg` instead of a local checkout; env-configurable `ICONS_DIR` /
  `OUT_DIR` / `TMPDIR` / `SRC`; no machine paths). Guarded by
  `tests/packaging.test.ts`.
- **No automated coverage of the pipeline** — by design (external tools); this
  is the manual test plan's job. Re-evaluate if a reliable harness becomes
  feasible.

## Update triggers

Update this file when you: add/change/remove a requirement in
`../requirements.md`; ship a Design-only item; regress or defer a Shipped one;
or close/open a follow-up that changes an area's status.

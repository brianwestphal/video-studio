# video-studio — Requirements

The source-of-truth description of what video-studio does. Keep this in sync with
the code **in the same change** that alters behavior. The synthesized views for
AI assistants live in [`ai/codebase-map.md`](ai/codebase-map.md) and
[`ai/requirements-summary.md`](ai/requirements-summary.md); the manual test
checklist is [`manual-test-plan.md`](manual-test-plan.md).

> ⚠️ **Early concept.** Requirements here describe current intent for a pre-1.0
> experiment and may change.

## 1. Purpose

Turn **one long source video** into **short promo cuts** (teasers, vertical
social cuts, tightened long edits) on macOS, driven from Claude Code. The
deliverable is always a **finished, rendered video file** — never just a
timeline or edit decision list.

## 2. Platform & dependencies

- **R2.1** macOS only. The launcher must refuse to run elsewhere with a clear
  message.
- **R2.2** Requires Node ≥ 18, `ffmpeg`/`ffprobe`, and the `claude` CLI.
- **R2.3** `whisper` is required for word-level soundbite timing.
- **R2.4** Ollama is **optional** — used only for offline auto-descriptions.
  The default path is **Claude describing extracted frames itself** (no vision
  API, no local model).
- **R2.5** The launcher must detect each tool, report status, and offer to
  `brew install` the installable ones.

## 3. Launcher (`bin/video-studio.mjs`, the `video-studio` bin)

- **R3.1** Default run: check tools → install missing (with consent) → install
  npm deps + build the analyzer → install the Claude skill(s) → launch `claude`
  in the work dir.
- **R3.2** `--check` / `--doctor`: report tool status only; install nothing,
  launch nothing; exit message reflects whether required tools are missing.
- **R3.3** `--no-launch`: full setup but don't start Claude.
- **R3.4** `--skills-only`: (re)install the Claude skill(s) and exit.
- **R3.5** `--yes`/`-y`: auto-install missing tools without prompting.
- **R3.6** `--help`/`-h`: print usage.
- **R3.7** Skill install copies `skills/*` into `~/.claude/skills/` and
  substitutes the absolute toolkit path for `{{TOOLKIT_DIR}}` in each `SKILL.md`.

## 4. Scene analyzer (`src/analyzer.ts` → `dist/analyzer.js`, the `video-scene-analyzer` bin)

- **R4.1** Probe duration + frame rate via ffprobe; never assume fps.
- **R4.2** Full-decode scene detection: keep frames whose ffmpeg `scene` score
  exceeds `SCENE_THRESHOLD` (0.4).
- **R4.3** Convert cut times to frame-accurate `[startFrame, endFrame)` ranges,
  snapping to the nearest frame and merging boundaries closer than
  `MIN_SCENE_SEC` (1.0s).
- **R4.4** Extract one representative frame (scene midpoint) per scene into
  `<dataDir>/frames/`.
- **R4.5** Emit a frame-accurate timeline (`<dataDir>/timeline.json`, plus
  `--out <path>`): per scene `start`/`end` as `HH:MM:SS:FF`, `startFrame`,
  `endFrame`, `startSeconds`, `endSeconds`, `framePath`, `description`.
- **R4.6** Descriptions are **blank by default** for Claude to fill from the
  frames; `--describe ollama` (with `--model`, default `gemma4:12b`) fills them
  locally.
- **R4.7** **Resumable & idempotent**: persist state (`<dataDir>/state.json`,
  versioned) keyed to the video's path+size+mtime. A re-run resumes detection
  and description; a changed/different video starts fresh. State writes are
  atomic (temp + rename).
- **R4.8** Known-failure errors (ffmpeg missing, Ollama unreachable, model
  missing) surface as **resumable** errors with fix-and-re-run instructions and
  a non-zero exit; progress is preserved.

## 5. Overlay generator (`tools/render-caption.mjs`, the `render-caption` tool)

- **R5.1** Produce an **animated SVG** caption/lower-third/CTA, to be rendered
  to alpha video by `svg-to-video` for compositing.
- **R5.2** Styles: `pill` (default), `plain`, `cta`. Positions: `lower-third`
  (default), `center`, `upper-third`. Multi-line via repeated `--text`.
- **R5.3** Options: `--duration`, `--fps`, `--width`/`--height`, `--accent`,
  `--icon` (SVG, ids namespaced to avoid collisions), `--font`, `--size`,
  `--out` (required).
- **R5.4** Animation bakes a fade-in, a single long hold, and a fade-out so the
  overlay doesn't fade mid-hold; render at the video's real fps.
- **R5.5** Validation: at least one `--text` and an `--out` are required;
  unknown flags error with a non-zero exit.

## 6. The skill (`skills/video-studio/SKILL.md`)

- **R6.1** The skill is the **primary interface**: it directs Claude through
  probe → scene analysis (Claude describes frames) → whisper word timing →
  cut design → overlay generation → ffmpeg compositing → frame-sampled
  verification.
- **R6.2** Cut archetypes: teaser (~15s, hook in 3s, clean soundbites, silent
  B-roll, end-card CTA), social 9:16 (≤3min, vertical, reframed), long edit
  (≤15min, light trims).
- **R6.3** Always produce a finished file and **verify** it (sample frames,
  check audio levels, re-whisper soundbites). Never stop at a timeline.
- **R6.4** Output conventions: finished cuts next to the source, intermediates
  under a work dir; save the assembly as a re-runnable shell script; keep CTAs
  editable via a `{{PLACEHOLDER}}` URL.

## 7. Quality gates

- **R7.1** Pure logic (`src/scene-math.ts`, `src/analyzer-cli.ts`,
  `src/analyzer-state.ts`, `src/resumable-error.ts`, `tools/caption-format.mjs`)
  is unit-tested to 100% lines/branches/functions/statements (Vitest).
- **R7.2** The external-tool pipeline is covered by
  [`manual-test-plan.md`](manual-test-plan.md).
- **R7.3** `npm run check` (lint → typecheck → test → build) must pass before a
  change is finished; CI enforces the same on push/PR.
- **R7.4** Releases are tag-driven; CI publishes to npm with provenance. See
  [`releasing.md`](releasing.md).

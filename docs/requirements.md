# video-studio — Requirements

The source-of-truth description of what video-studio does. Keep this in sync with
the code **in the same change** that alters behavior. The synthesized views for
AI assistants live in [`ai/codebase-map.md`](ai/codebase-map.md) and
[`ai/requirements-summary.md`](ai/requirements-summary.md); the manual test
checklist is [`manual-test-plan.md`](manual-test-plan.md).

> **Early concept.** Requirements here describe current intent for a pre-1.0
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
  npm deps + build the analyzer → install the Claude skill(s) → pause for Enter
  (when on a TTY, so the getting-started splash is readable) → launch `claude`
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
- **R6.4** Output conventions: finished cuts next to the source, scratch encodes
  under a work dir; save the assembly as a re-runnable shell script; keep CTAs
  editable via a `{{PLACEHOLDER}}` URL.
- **R6.5** Retain the AI-interpretation intermediates as durable artifacts (not
  `/tmp` scratch): the scene breakdown (`timeline.json` with descriptions) and
  the whisper transcripts (`<dataDir>/transcripts/`). They record how the model
  read the footage and are reusable across cuts. See [`ai/`](ai/) summaries and
  the committed examples in [`samples/`](samples/).

## 7. Quality gates

- **R7.1** Pure logic is unit-tested to 100%
  lines/branches/functions/statements (Vitest); every file in `vitest.config.ts`
  `coverage.include` is held to that threshold. That list is the source of truth
  for which modules are covered (currently the `src/` analyzer cores plus the pure
  `tools/*.mjs` modules); a pure module must be added to it when extracted.
- **R7.2** The external-tool pipeline is covered by
  [`manual-test-plan.md`](manual-test-plan.md).
- **R7.3** `npm run check` (lint → typecheck → test → `check:features` → build)
  must pass before a change is finished; CI enforces the same on push/PR.
- **R7.4** Releases are tag-driven; CI publishes to npm with provenance. See
  [`releasing.md`](releasing.md).
- **R7.5** Coverage is measured on **two orthogonal axes**: line/branch coverage
  (100% on the pure modules) proves every line *ran*; **feature/requirement
  coverage** ([`feature-coverage.md`](feature-coverage.md)) proves every documented
  requirement is *asserted* by a test (or a deliberate manual/review/gate/deferred
  classification). `npm run check:features` (and `tests/conventions.test.ts`) fail
  if any documented requirement — including a state *transition* — has no coverage
  decision. Line coverage is a **floor, not a ceiling**.

## 8. Functional-area docs

Larger features have their own source-of-truth docs (kept in sync the same way):

- **Feature / requirement coverage** — [`feature-coverage.md`](feature-coverage.md) *(shipped, R7.5; the second coverage axis + `check:features`)*
- **Editor handoff** — [`editor-handoff.md`](editor-handoff.md) *(shipped)*
- **Captions and subtitles** — [`captions.md`](captions.md) *(design complete; R-CAP1–R-CAP12, VS-111)*
- **Multiple sources** — [`multiple-sources.md`](multiple-sources.md) *(shipped)*
- **Multi-cam editing** — [`multicam.md`](multicam.md) + [`multicam-sync.md`](multicam-sync.md) *(shipped; FCP import validated, VS-36)*
- **FCP-incompatible source audio detection** — [`fcp-audio-compat.md`](fcp-audio-compat.md) *(shipped, VS-40; warn-only, R-FA)*
- **FCP transition suggestions** — [`transitions.md`](transitions.md) *(shipped: FCPXML `<transition>`s VS-28/50)*
- **Render transitions into the video (no FCP)** — [`render-transitions.md`](render-transitions.md) *(shipped, R-RT1–R-RT9; VS-54 Tier A, VS-55 windowed re-encode + native Tier B/C)*
- **Edit awareness / auto multi-cam cutting** *(specs VS-41/42/43; audio-events Tier 1+2 shipped VS-44/49; per-angle visual saliency shipped VS-45; selector shipped VS-46; integration shipped VS-47; shot-length policy + long-take exception shipped VS-62)*:
  [`audio-events.md`](audio-events.md) (non-speech/musical audio events, R-AE1–R-AE8),
  [`visual-saliency.md`](visual-saliency.md) (per-angle "what's worth showing", R-VS1–R-VS5, **shipped**),
  [`multicam-auto-cut.md`](multicam-auto-cut.md) (audio+visual → `switches`, R-AC),
  and [`multicam-review-ui.md`](multicam-review-ui.md) (review low-confidence cuts in a
  local web UI, R-RUI — flag signal shipped R-AC9, UI design only).
- **Desktop app (VS-76 initiative)** *(design only — a native Tauri shell over the
  existing pipeline; nothing built yet)*:
  [`desktop-app.md`](desktop-app.md) (shell, project model, stage navigation + Node sidecar
  host, R-APP, VS-80),
  [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md) (Auto lane via a **pluggable**
  AI agent backend — Claude / Codex / Ollama — structured events → UI, R-CB1–R-CB11, VS-83),
  [`desktop-app-permissions.md`](desktop-app-permissions.md) (app-owned category-based
  permission & safety layer, R-PERM1–R-PERM12, VS-85),
  [`desktop-app-export.md`](desktop-app-export.md) (Export lane — MP4 / 9:16 / FCPXML
  over the shipped exporters + Reveal in Finder, R-EX1–R-EX5, VS-88),
  [`desktop-app-review.md`](desktop-app-review.md) (optional Design timeline editor — embed
  the shipped `review-switches` UI via an iframe, R-RV1–R-RV3, VS-87/113),
  and [`desktop-app-design.md`](desktop-app-design.md) (Design stage — Auto prompt + optional
  timeline editor, R-DS1–R-DS4, VS-86/113). Concept + roadmap:
  [`investigations/ui-app.md`](investigations/ui-app.md).

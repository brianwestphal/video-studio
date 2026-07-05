# Desktop app — Analyze stage (VS-82)

The **Analyze** stage (wireframe screen 03) is the project's **deeper, distinct** pass that runs
*after* import: local, no-AI analysis that produces the musical / edit-awareness data the Design
stage consumes. It is separate from import's scene detection — import establishes the source
shape (`sources.json` / `multicam.json`); Analyze adds `audio-events.json`.

Part of the desktop-app initiative — see [`desktop-app.md`](desktop-app.md). Analyze sits between
[Import](desktop-app-import.md) and [Design](desktop-app-design.md).

Status: **Partial** — the audio-events pass is **built and functional** (engine label + step list
+ live progress + cancel + auto-advance). Per-angle visual saliency, the scene contact-sheet
thumbnail wall, and determinate progress are documented follow-ups. Depends on VS-90 (sidecar
host + project model) and VS-81 (import writing the source artifact).

## 1. The deeper pass

- **R-AN1** Analyze runs the project's deeper local pass: `audio-events` over the project's
  **primary video** → `audio-events.json` (loudness, onsets, quiet, vocal / instrumental
  sections) — the edit-awareness data Design's `propose-switches` (multi-cam) and `proposeCutSpec`
  (single-source) consume. It is **distinct from import's scene detection**. The argv + output
  path are the pure `analyzeProjectCommand` (`desktop/sidecar/steps.mjs`, unit-tested); it throws
  when the folder has no video. The `readdir` + child-process spawn is the `analyze-project` host
  step (I/O). See [`audio-events.md`](audio-events.md).

## 2. Setting expectations

- **R-AN2** Before running, the Analyze screen **sets expectations**: an **engine label** ("runs
  on your machine (ffmpeg + whisper) — no AI, no cost") and a **step list** (`ANALYSIS_PLAN`)
  naming what will run, so the stage does not read as a redundant repeat of import. *(GUI;
  manual-test-plan §15.3-15.4.)*

## 3. Running it

- **R-AN3** Running analysis streams **live status** on an indeterminate progress bar and is
  **cancellable** (`runCancellable`). On completion it writes `audio-events.json`, marks the
  stage **done**, and **auto-advances** the flow (import → Analyze → Design) so there is always a
  clear next step; reachable tabs render clearly clickable and done stages get a check. *(GUI/I-O;
  manual-test-plan §15.3-15.4.)*

## 4. Follow-ups (documented, not yet built)

- **R-AN4** *(partial)* Per-angle **visual saliency** for multi-cam projects
  (`analyze-visual-saliency` → `saliency.json`), which sharpens the auto-cut. The app already
  **reads** `saliency.json` when present (the Design proposal passes `--saliency`). The pure
  argv builder (`saliencyCommand`, unit-tested) is now in place — it runs the tool over the
  group's `multicam.json`, passing `--audio-events` when present; the host `analyze-saliency`
  step (spawn) + Analyze-screen wiring that actually **produces** it are the remaining tail.
- **R-AN5** *(deferred)* A scene **contact-sheet thumbnail wall** that fills as scenes are
  detected, giving a visual read of the footage during analysis.
- **R-AN6** *(deferred)* **Determinate** progress where the underlying tool emits a percentage
  (today the Analyze bar is indeterminate; VS-60 already emits granular per-call progress that
  could drive it).

## 5. Cross-references

- [`audio-events.md`](audio-events.md) — `audio-events` (the analysis Analyze runs).
- [`desktop-app-import.md`](desktop-app-import.md) — the stage before Analyze (VS-81).
- [`desktop-app-design.md`](desktop-app-design.md) — the stage after Analyze that consumes
  `audio-events.json` (VS-86).
- [`visual-saliency.md`](visual-saliency.md) — per-angle saliency (the R-AN4 follow-up).

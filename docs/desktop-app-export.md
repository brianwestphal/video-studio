# Desktop app — Export lane (VS-88)

The final stage (wireframe screen 06): turn the current project's reviewed cut into a
**finished file** with one click, over the **shipped** exporters/renderers — no new engine.

Part of the desktop-app initiative — see the umbrella [`desktop-app.md`](desktop-app.md)
(shell + sidecar host + project model). Reuses the multi-cam export/render tools documented
in [`multicam.md`](multicam.md) + [`render-transitions.md`](render-transitions.md).

Status: **Partial** — the export step descriptors + the Export screen are built; the heavy
ffmpeg render itself is manual-test territory (external tool). Depends on VS-90 (sidecar +
project model) and a cut (`switches.json`, VS-87); works on a single angle without one.

## 1. Three one-click outcomes

- **R-EX1** The Export screen offers **three outcomes** over the existing tools, each a
  sidecar step that reuses a shipped CLI **as-is**:
  - **MP4** — a finished 16:9 render (`tools/render-multicam-preview.mjs`, the flat
    render + baked transitions), default 1280×720.
  - **9:16 social** — the same render at a vertical **1080×1920** frame (same tool, social
    dimensions). True subject-aware reframing is a follow-up; the MVP reuses the renderer.
  - **FCPXML** — a Final Cut Pro handoff (`tools/export-multicam-fcpxml.mjs`), a re-cuttable
    `<mc-clip>` referencing the original media (fast; no render).
- **R-EX2** Each outcome reads the current project's `multicam.json` and, when present, the
  reviewed cut `switches.json` (omitted for a single-angle export), and writes into the
  project's **`exports/`** folder. The output path is a **pure function** of the project
  folder + outcome (unit-tested); the host creates `exports/` and spawns the tool (I/O).

## 2. Progress + status + reveal

- **R-EX3** Each outcome **streams progress** through the sidecar (the tool's stdout/stderr
  → normalized progress events) and shows a **per-outcome status**: `ready` → `rendering`
  → `done` (or `error`).
- **R-EX4** On completion the screen offers **Reveal in Finder** (a native `open -R` on the
  output file), so the finished file is one click from the app.

## 3. Defaults + reuse

- **R-EX5** Sensible **defaults** (resolution per outcome, x264 CRF) apply with no
  configuration. The pure `exportCommand` now also accepts **width / height / crf** overrides
  (unit-tested): a finite value overrides the per-kind default, and `crf` is honored only by
  the mp4 renderer (the FCPXML exporter has no encode pass) — `fps` is intentionally not
  exposed because neither exporter accepts it. The **UI advanced disclosure** that surfaces
  these controls is still a follow-up (VS-95). The lane adds **no engine** — it is glue over
  `render-multicam-preview` / `export-multicam-fcpxml`, which keep their own tests + manual
  coverage.

## 4. Cross-references

- [`desktop-app.md`](desktop-app.md) — the sidecar host + project model this builds on.
- [`multicam.md`](multicam.md) — the export/render tools + the `--switches` handoff.
- VS-87 (Review) produces the `switches.json` this consumes; VS-89 (packaging) handles the
  bundled ffmpeg question.

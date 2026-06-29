# Changelog

All notable changes to **video-studio** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Early concept.** video-studio is an experiment. Interfaces, the skill, and the toolkit layout may change without notice while it's pre-1.0.

## Unreleased

- **Editor handoff (Final Cut Pro)** — `export-project` turns a cut spec into a
  project folder of edit-grade pieces instead of a flat render: ProRes 422 HQ
  segments, ProRes 4444 alpha overlays, a `manifest.json` of frame-accurate target
  ranges, a `rebuild.sh` that re-composites the exact cut, and a Final Cut Pro
  `.fcpxml` (segments on the storyline, overlays as connected clips). Pure manifest
  + FCPXML logic in `tools/export-manifest.mjs` + `tools/fcpxml.mjs` (100% tested).
  See `docs/editor-handoff.md`.
- **Multiple source videos** — `analyze-sources` accepts any mix of files and
  folders, analyzes each independently (resumable per source), and writes a
  combined `sources.json`; a cut draws segments across sources by `(sourceId, in,
  out)` and conforms them to one project fps/frame size on export. See
  `docs/multiple-sources.md`.
- **Multi-cam audio sync** — new `sync-multicam` tool time-aligns several clips of
  one event by their audio (pure-JS FFT cross-correlation over ffmpeg-extracted
  mono), emitting `multicam.json` with a per-member offset + confidence. Audio-only
  recorder tracks become the sync reference and master audio; alignment is
  seconds-based so mismatched/non-integer frame rates (29.97 vs 30) just work;
  weak/non-overlapping audio falls back to a manual offset; long-take clock drift
  is detected and flagged. Pure DSP + manifest + angle-cut math in
  `tools/multicam.mjs` (100% unit-tested). Design + research: `docs/multicam.md`,
  `docs/multicam-sync.md`. (Angle-switching through the skill + editor
  handoff/FCPXML and drift *correction* are deferred follow-ups.)
  Sub-sample offset precision (parabolic peak interpolation, on by default;
  `--no-interpolate` to disable) and a `--feature phat` GCC-PHAT phase-whitened
  correlation for very low SNR (VS-32). New `propose-groups` tool suggests
  multicam groups from a `sources.json` pool by folder / overlapping recording
  windows / filename pattern (VS-31). Long-take clock drift now also yields a
  retime correction in the manifest (`rateCorrection` + start-anchored
  `correctedOffsetSeconds`; the drift windows are matched against a bounded
  reference region so repetitive audio doesn't mis-lock), ready for the export to
  apply (VS-30). **Angle switching** ships end to end: `expandMulticamGroup` turns
  a synced group + angle switch points into an editor-handoff cut spec (silent
  video angle-segments over a continuous master-audio track), the export muxes the
  master audio under the switching angles + writes FCPXML with it on a connected
  audio lane, and the skill drives the whole flow (VS-29). The cut spec gains an
  optional `audioTrack` (also usable for a music bed). New `export-multicam-fcpxml`
  emits a **true FCP `<mc-clip>` multicam asset** — one angle per synced member
  referencing the original media, with per-switch angle selection — so Final Cut
  Pro gets a live multicam clip you can re-cut in the angle viewer; and long-take
  drift is now **applied on export** (a drifting angle segment is `setpts`-retimed
  to fill its slot) (VS-33). The multicam FCPXML is generated to spec but should be
  validated by a real FCP import (see the manual test plan).
- **Launcher** — the launcher now pauses ("Press Enter to launch Claude…") so its getting-started splash is readable before Claude's UI takes over the terminal (skipped with `--yes` or no TTY).
- **Docs & onboarding** — added a `README.md`, an MIT `LICENSE` file, and a `docs/` set (requirements, release guide, manual test plan, and AI-summary maps).
- **Shippable worked examples** — the `promo-assets/` teaser + caption/wordmark example scripts now ship with the package and run anywhere (env-configurable paths; no hardcoded machine paths; use the published `domotion-svg`).
- **Hardened toolkit** — ESLint + Vitest with **100% coverage enforced on all ten pure modules** (scene/timecode math, analyzer CLI/state, error classification, caption assembly, the export manifest + FCPXML, source/multicam manifests, and the multi-cam DSP), and a tag-driven release flow with CI publishing to npm with provenance.
- **Internal** — the scene analyzer was split into focused modules (CLI, state, ffmpeg, ollama, error classification) with no change to its behavior or output.

## [0.1.0] - 2026-06-27



- Initial release of **video-studio** — a macOS toolkit for turning long videos into promo cuts, teasers, and social edits, drivable from Claude via `npx video-studio`.
- Frame-accurate scene analyzer (ffmpeg scene detection + representative-frame extraction) with Claude describing frames by default, Ollama optional via `--describe ollama`; resumable, and emits `HH:MM:SS:FF` timecodes plus frame/second fields.
- whisper word-level timing for precise soundbite in/out points.
- domotion-svg title cards, captions, and overlays rendered to alpha video and composited with ffmpeg, with frame-sampled verification.
- Documented the `--yes` flag for non-interactive runs.


- Analyzer no longer aborts (ffmpeg exit 234) on files whose container runs longer than the video stream — frame count is now derived from the video stream, fixing a phantom final scene that seeked past EOF (e.g. Tears of Steel).
- Bundled promo-asset examples now resolve correctly for users installing via npm.


- Refreshed README leading with a Highlights block and animated hero teaser, a "How it works" pipeline, a "How the AI reads the video" walkthrough with scene-description and transcript excerpts, and a Credits section; added demo media and removed decorative emoji across the docs.

## [0.0.0] - 2026-06-26

- Initial public concept release.
- macOS toolkit + Claude skill for turning long videos into promo cuts: frame-accurate scene analysis (ffmpeg + Claude/Ollama vision), whisper word-level timing, domotion-svg title cards / captions / overlays, and ffmpeg compositing.
- `video-studio` launcher (`bin/video-studio.mjs`) — tool doctor, npm/build bootstrap, and Claude skill installer.
- `video-scene-analyzer` (`dist/analyzer.js`) — resumable, frame-accurate scene detection.
- `render-caption` tool for animated caption / lower-third / CTA overlays.

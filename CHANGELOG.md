# Changelog

All notable changes to **video-studio** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Early concept.** video-studio is an experiment. Interfaces, the skill, and the toolkit layout may change without notice while it's pre-1.0.

## Unreleased

- **Dependency: `domotion-svg` 0.15.0 → 0.20.0** — bumped the overlay/animation
  renderer. The `render-caption.mjs` call sites (`captureElementTree`,
  `embedRemoteImages`, `elementTreeToSvgInner`, `generateAnimatedSvg`, `optimizeSvg`)
  are API-compatible with 0.20 (verified against the shipped type defs — same
  signatures + `AnimationConfig`/`AnimationFrame` shapes), so no code changes were
  needed. Generated demo media (`docs/media/`) rebuilt with the new renderer.
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
  to fill its slot) (VS-33). The multicam spine `<mc-clip>`s are laid on exact
  frame boundaries so consecutive angle spans abut precisely and the timeline ends
  on the sequence duration — fixing ±1-frame gaps/overlaps that independent
  per-clip rounding produced at non-integer rates like 23.976 (VS-36). Each spine
  `<mc-clip>` selects **audio from the master-audio angle** (and video from the
  active camera) via `<mc-source>`, so the multicam aligns the audio to the picture
  natively — it stays in sync even where the master audio leads the first video
  frame (a separate connected audio clip drifts ahead in FCP's multicam, VS-36).
  The audio-only asset no longer carries a (video) `format`, and its `duration` is
  declared **sample-exactly** (e.g. `120081/500s`) instead of video-frame-quantized
  — a frame-quantized audio duration lands between samples and slightly short of
  the real media, so FCP rejected every full-length audio edit with "Invalid edit
  with no respective media." (The same `format`/sample-duration fixes apply to the
  flat export's master-audio asset; that export keeps its connected audio lane,
  which works there — VS-36.) New
  `render-multicam-preview` renders the same group + switches to a flat MP4 so you
  can watch the angle cut (master audio underneath, black where an angle hasn't
  rolled yet) and compare it against the FCP import without opening FCP (VS-36).
  Both the export and the preview take an optional **`--start <sec>`** to trim
  leading dead air (the black head while the master audio plays before the cameras
  roll) by re-basing the timeline — audio stays locked either way (VS-36). Each
  camera angle's leading gap is filled with **real black video** (a generated
  `<name>.black.mp4`) so the multicam has frames from time 0; without it FCP anchors
  the multicam to the earliest camera and plays the master audio late by that
  offset (disable with `--no-black-fill`) (VS-36).
  The multicam FCPXML is generated to spec but should be validated by a real FCP
  import (see the manual test plan).
- **Transitions** — an opt-in `transitions` block on the cut spec emits Final Cut
  Pro `<transition>` elements into the editor-handoff `.fcpxml` (the full 16-built-in
  palette: dissolves/fades, movements, wipes, insets/splits, Static), with handle
  media baked into the flanking segments; the output validates against FCP's bundled
  DTD (VS-28/50). New **`render-transitions`** additionally bakes the transitions
  into a finished `.mov` with **no Final Cut Pro required** (VS-54/55). The default
  **windowed** renderer re-encodes only the short overlap at each transition and
  stream-copy-concats the rest, so the cost is ≈ the total transition duration
  regardless of how long the cut is (`--full-chain` keeps the original
  whole-timeline graph). All three effort tiers render natively: Tier A direct
  `xfade`, Tier B `xfade=custom` expressions (Chevron, Static), and Tier C
  overlay-mask / crop-and-slide (Circle/Rectangle/Shapes Inset, Side-by-Side /
  Top & Bottom Split). Pure recipe maps + render plans in
  `tools/transitions-render.mjs` (100% tested). See `docs/render-transitions.md`.
- **Launcher** — the launcher now pauses ("Press Enter to launch Claude…") so its getting-started splash is readable before Claude's UI takes over the terminal (skipped with `--yes` or no TTY).
- **Docs & onboarding** — added a `README.md`, an MIT `LICENSE` file, and a `docs/` set (requirements, release guide, manual test plan, and AI-summary maps).
- **Shippable worked examples** — the `promo-assets/` teaser + caption/wordmark example scripts now ship with the package and run anywhere (env-configurable paths; no hardcoded machine paths; use the published `domotion-svg`).
- **Hardened toolkit** — ESLint + Vitest with **100% coverage enforced on all ten pure modules** (scene/timecode math, analyzer CLI/state, error classification, caption assembly, the export manifest + FCPXML, source/multicam manifests, and the multi-cam DSP), and a tag-driven release flow with CI publishing to npm with provenance.
- **Internal** — the scene analyzer was split into focused modules (CLI, state, ffmpeg, ollama, error classification) with no change to its behavior or output. The multi-cam logic was likewise split: the signal DSP (FFT cross-correlation, drift fit) now lives in `tools/multicam-dsp.mjs`, with `tools/multicam.mjs` keeping the group-manifest + angle-cut assembly (no behavior change).

## [0.2.1] - 2026-07-03



- Fixed `npx video-studio` and global installs failing to start with TypeScript build errors — the launcher no longer tries to rebuild the analyzer for installed users, relying on the prebuilt files shipped with the package.

## [0.2.0] - 2026-07-03



- Sync several clips of one event by their audio into a group manifest with per-angle offsets and confidence — sub-sample precision, an optional GCC-PHAT method, and drift correction for long takes.
- Automatically propose camera groups from a pool of sources, by folder, overlapping recording time, or filename.
- Automatic angle selection: propose angle switches by correlating audio events with per-angle visual saliency (riff → instrument angle, vocals → the active singer), with shot-length limits (max 8s / min 0.5s), an instrumental long-take exception, and shot-type variety so two similar shots don't run back to back.
- Turn synced groups into a switching cut end to end, from angle switches through the editor handoff.


- New review page to inspect and edit low-confidence angle switches: synchronized per-segment playback with a single audio focus, per-clip transport, and fullscreen.
- Each preview marks its section-of-interest (the actual shot vs. lead-in/out) with a scrubber band and time range.
- Load a whole-video assembled timeline preview that plays the full multi-cam edit and live-updates as picks change.
- Force-add any cut to review even if unflagged, split at the playhead, dock the timeline, and opt-in to re-propose downstream switches around your locked picks.


- Export the edit as a live, re-cuttable Final Cut Pro multicam clip (angle viewer + master audio) or a Final Cut Pro X project (.fcpxml) alongside the rendered segments and overlays.
- Suggest FCP transitions at chosen cuts, drawing on the full 16-transition built-in palette.
- Opt-in `--fcp-normalize-audio` re-encodes Pro Tools / BWF WAVs that FCP can't import into a sidecar so the timeline imports with sound; without the flag, such files now raise a warning instead of importing silently.


- Bake real transitions into the finished video with ffmpeg — no NLE required. The default windowed renderer re-encodes only each transition window (~4x faster than a full-timeline pass) and renders native Tier A/B/C transitions, including feathered inset edges.


- Export a designed cut as an NLE-ready project folder: individual ProRes segments, alpha overlays, a JSON manifest of target time ranges, and a `rebuild.sh`.
- Build a cut from a pool of source videos and folders instead of a single recording.


- Non-speech audio-events pass: loudness envelope, onset detection, and quiet/vocal/instrumental sectioning gated by the transcript, plus Tier-2 spectral descriptors and structural boundaries.
- Per-angle visual saliency scoring (performer, instrument-in-use, motion, framing, presence) for the angle selector, with a cheap motion pre-pass that gates the costly vision calls.


- Multi-cam FCPXML now imports into Final Cut Pro with audio in sync — frame-exact spine placement, sample-exact audio-asset duration, black-fill of each angle's leading gap, and correct handling of audio-only assets.
- Refined saliency so a head-down instrumentalist is no longer read as the active singer, fixing wrong-angle holds during vocals.
- Drop a sub-frame runt shot that could land at the very end of the timeline.


- Per-vision-call progress during the long saliency pass (angle, call count, average time, ETA).
- The launcher now pauses on its getting-started splash until you press Enter, so it isn't wiped the moment Claude starts.

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

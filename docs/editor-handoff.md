# Editor Handoff — export segments + overlays for manual finishing

Status: **Implemented.** `tools/export-project.mjs` emits segments (ProRes 422 HQ)
+ overlays (ProRes 4444 alpha) + `manifest.json` + `rebuild.sh` (VS-24) **and**
an FCPXML for Final Cut Pro import (VS-25). Pure logic + 100% tests in
`tools/export-manifest.mjs` and `tools/fcpxml.mjs`. Covers VS-20 (export ordered
segments) and VS-21 (export overlays as separate files), which share the
manifest/FCPXML design, so they're specified together here.

## Cut spec (input)

`export-project <cut-spec.json> [--out <dir>]` consumes a small JSON the skill
writes after designing the cut (source paths resolve relative to the spec file):

```json
{
  "project": { "fps": 24, "width": 1920, "height": 1080, "name": "teaser" },
  "clips": [
    { "source": "a.mov", "in": 36.18, "out": 39.20, "audio": "keep" },
    { "source": "a.mov", "in": 1189.0, "out": 1191.25, "audio": "silent" }
  ],
  "overlays": [
    { "file": "cap.mov", "overClip": 0, "atOffset": 0.5, "position": "lower-third" }
  ],
  "audioTrack": { "source": "recorder.wav", "in": 0, "durationSeconds": 8 }
}
```

`clips` are in cut order (`in`/`out` in seconds; `audio` is `keep`|`silent`).
Each `overlay` references an already-rendered alpha clip (`file`) and sits over
clip `overClip` starting `atOffset` seconds into it; its duration is taken from
the file unless `duration` is given. The optional **`audioTrack`** lays one
continuous audio source under the whole timeline (its `durationSeconds` defaults
to the timeline length) — used for **multi-cam** (silent video angle-segments +
master audio; see [`multicam-sync.md`](multicam-sync.md), built by
`expandMulticamGroup`) or a music bed. It is extracted to `audio/master.mov`,
muxed under the video by `rebuild.sh`, and attached to the FCPXML on a connected
audio lane.

> **Early concept.** Design intent for a pre-1.0 feature; details may change.

## 1. Purpose

Today video-studio renders **one finished video**. This feature lets it instead
(or additionally) export the **building blocks** of a cut so the user can do a
finishing pass in a real NLE — primarily **Final Cut Pro** — adding their own
transitions, grades, and audio work:

- the chosen **segments** as individual, ordered video files;
- the **overlays** (title cards, lower-thirds, captions, CTAs) as individual
  files with transparency;
- machine-readable **manifests** that state where each piece belongs in the final
  timeline, plus an **FCPXML** that lays the whole assembly out for direct import.

Design decisions (confirmed with the maintainer): manifest = **JSON + FCPXML**;
segment codec = **ProRes 422 HQ**; overlay codec = **ProRes 4444** (alpha).

## 2. Output layout

A single export produces a project directory next to the source, e.g.:

```
<video>.studio-export/
  segments/   seg-001.mov, seg-002.mov, …          # ProRes 422 HQ, in cut order
  overlays/   ov-001.mov,  ov-002.mov,  …           # ProRes 4444 (alpha)
  audio/      master.mov                            # continuous audioTrack (when present), PCM
  manifest.json                                     # the machine-readable manifest
  <project>.fcpxml                                   # Final Cut Pro import
  rebuild.sh                                        # re-composites the final cut from the pieces
```

## 3. Segment export (VS-20)

- **R-EH1** Export each chosen segment as its own file in `segments/`, numbered in
  final-cut order (`seg-001`, `seg-002`, …).
- **R-EH2** Encode segments as **ProRes 422 HQ** (`-c:v prores_ks -profile:v 3`),
  frame-accurate in/out (no keyframe snapping), preserving the source fps and the
  segment's audio (soundbite audio kept; B-roll silent per the cut design).
- **R-EH3** Each segment's source provenance is recorded in the manifest: source
  file + source in/out timecode (so the cut is reproducible / re-cuttable).
- **R-EH4** Segment export is an **option**, not a replacement: the existing
  single-file render still works. Selecting export can still also emit the final
  concatenated cut (for reference) unless told otherwise.

## 4. Overlay export (VS-21)

- **R-EH5** Export each overlay as its own file in `overlays/`, encoded as
  **ProRes 4444** with a real alpha channel (`-c:v prores_ks -profile:v 4444
  -pix_fmt yuva444p10le`), so it can be composited manually.
- **R-EH6** Each overlay file spans only its own active duration (its baked
  fade-in → hold → fade-out), at the project fps and frame size.
- **R-EH7** The manifest records, per overlay: the file, its **target start/end in
  the final timeline**, its frame size/position/anchor (lower-third, center,
  etc.), and which segment(s) it sits over.
- **R-EH8** Default is **one file per overlay** (max flexibility). A future option
  may also emit a single full-length combined alpha track (drop-in over the whole
  edit) — see Open questions.

## 5. JSON manifest

- **R-EH9** `manifest.json` is the tool-agnostic source of truth. It describes the
  final timeline: project fps + frame size, an ordered list of **segments** (file,
  target start/end as `HH:MM:SS:FF` + seconds + frames, source file + source
  in/out, audio kept/silent), and a list of **overlays** (file, target start/end,
  position/anchor, over-segment ref). Times are frame-accurate and absolute in the
  final timeline.
- **R-EH9a** When the cut spec has an `audioTrack`, the manifest records it
  (`audio/master.mov`, source + source-in + duration) — one continuous audio bed
  under the timeline (the multi-cam master audio, or a music bed). Segments are
  silent in that case; `rebuild.sh` muxes the master audio under the video.
- **R-EH9b** A clip may carry a `rateCorrection` (multi-cam drift retime): its
  source span is `1/rate` of its timeline slot, so the segment is `setpts`-stretched
  on export and its manifest `durationSeconds` is the slot length. Recorded on the
  segment when present.
- **R-EH10** The manifest is sufficient to **re-composite the exact final cut**
  (the `rebuild.sh` does this), and to verify the export by frame-sampling.

## 6. FCPXML

- **R-EH11** Emit a Final Cut Pro X XML (`<project>.fcpxml`, DTD-valid) that:
  places the segments on the **primary storyline** in order at their target
  ranges, and attaches each overlay as a **connected clip** above its segment at
  the overlay's target range; references the exported `segments/` + `overlays/`
  files; and sets the sequence format from the project fps/frame size. When an
  `audioTrack` is present it is an audio-only asset attached as a connected clip
  on **lane -1** of the first segment, spanning the whole sequence.
- **R-EH12** Frame-rate aware: the FCPXML `frameDuration` and all clip
  offsets/durations use rational time at the project fps (e.g. `1001/30000s` for
  29.97) so FCP imports without conform warnings.
- **R-EH13** Importing the FCPXML yields the assembled cut on an FCP timeline, so
  the user can do their transition/finishing pass. (Round-trip back into
  video-studio is out of scope for v1.)

## 7. Likely implementation (non-binding)

- A small generator (a new tool/bin, e.g. `tools/export-project.mjs`) that takes
  the cut design (the manifest model) + the source(s) and writes `segments/`,
  `overlays/`, `manifest.json`, the FCPXML, and `rebuild.sh`.
- The `video-studio` **skill** orchestrates it: after designing the cut, instead
  of only compositing, it can populate the manifest model and invoke the
  generator. SKILL.md gains an "export for manual finishing" step.
- Overlay export reuses the existing `render-caption` → `svg-to-video` alpha
  pipeline (already ProRes 4444 capable).

## 8. Open questions / follow-ups

- Combined full-length alpha overlay track in addition to per-overlay files? (R-EH8)
- Do segments need **handles** (a few frames of padding beyond the cut) so the
  user can adjust transitions in FCP without running out of media? (Common NLE
  practice — likely yes; confirm length, e.g. 12–24 frames.)
- Audio: export B-roll segments truly silent, or muted-but-present (so FCP shows a
  track)? Separate audio stems?
- FCPXML version target (FCP 10.x compatibility) and whether to also offer the
  simpler EDL/CSV for other NLEs.

See [`requirements.md`](requirements.md) for the core pipeline and
[`multiple-sources.md`](multiple-sources.md) (segment `source` refs become
source-ids once multi-source lands).

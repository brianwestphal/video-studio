# Multiple Source Videos

Status: **Design only** (not yet implemented). Covers VS-18.

> **Early concept.** Design intent for a pre-1.0 feature; details may change.

## 1. Purpose

A cut is often assembled from **many source files**, not one long recording — a
folder of clips, several takes, B-roll from different shoots. Today the analyzer
and skill take a single video. This feature lets video-studio draw from a **pool
of sources** when designing a cut.

Design decision (confirmed): inputs are **any mix of explicit files and folders**
(folders recursed); each source is analyzed independently; a combined manifest
references every clip by **source + timecode**.

## 2. Requirements

- **R-MS1** Accept one or more inputs that may each be a **file or a folder**.
  Folders are recursed; only recognized video extensions are picked up
  (`.mp4/.mov/.m4v/.mkv/.webm/…`), in a stable (sorted) order. De-duplicate by
  resolved path.
- **R-MS2** Assign each source a stable **source id** (e.g. a short slug from the
  filename, disambiguated on collision) used everywhere downstream.
- **R-MS3** **Analyze each source independently** with the existing frame-accurate
  scene analyzer; per-source resumable state keyed to that file (the current
  per-video state model, one data dir per source). fps is probed per source (they
  may differ).
- **R-MS4** Produce a **combined sources manifest** (`sources.json`): for each
  source — id, path, duration, fps, frame size — and the union of detected scenes,
  each tagged with its `sourceId` and source-relative timecodes/frames.
- **R-MS5** **Cut design references clips by `(sourceId, in, out)`.** A single cut
  freely interleaves segments from different sources. Compositing extracts each
  segment from the correct source file.
- **R-MS6** **Mixed fps is expected.** Each source keeps its own fps in analysis;
  on export/compositing, segments are conformed to one **project fps/frame size**
  (chosen by the cut, defaulting to the most common or highest source fps).
- **R-MS7** Ties into [`editor-handoff.md`](editor-handoff.md): the segment
  manifest entries carry `sourceId` + source in/out, and the FCPXML references the
  correct source assets.

## 3. Likely implementation (non-binding)

- Extend the analyzer/skill entry to accept multiple positional inputs + folders,
  expand folders to a sorted file list, and run the existing per-file analysis in
  a loop (resumable per source), writing `sources.json` alongside the per-source
  `timeline.json`s.
- The skill's cut-design step reads `sources.json` (+ transcripts per source) and
  picks segments across sources; compositing already extracts by time range — it
  just needs the right input file per segment.
- Largely a skill-guidance + manifest change; the analyzer's core stays per-file.

## 4. Open questions / follow-ups

- One shared data/work dir with per-source subfolders, or a data dir per source?
- How should the skill present a large pool to the user for selection (contact
  sheets per source, a combined index)?
- Cross-source description/transcript indexing for "find the moment where…"
  search across the whole pool.
- Interaction with [`multicam.md`](multicam.md): a multicam group is a labeled
  subset of the source pool that also gets audio-synced.

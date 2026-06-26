# Multi-cam Editing

Status: **Design only** — implementation deferred (VS-19 is low priority and this
is the hardest of the input features). Builds on
[`multiple-sources.md`](multiple-sources.md): a multicam group is a labeled subset
of the source pool that is **time-aligned** so the cut can switch angles.

> **Early concept.** Design intent; the hard problems (sample-accurate audio sync,
> long-clip drift, variable frame rates) are called out below rather than solved.

## 1. Purpose

Mirror the Final Cut Pro multicam workflow: identify which sources cover the
**same moment from different angles**, **sync them** (usually by audio), then let
the cut **switch angles** over a shared timeline. Crucially, the best audio is
often a **separate recording**, and frame rates frequently **don't match**.

## 2. Requirements

- **R-MC1 Grouping.** The user (or the AI, with confirmation) labels a set of
  sources as a **multicam group** representing one continuous event from multiple
  cameras/recorders. A project may have several groups.
- **R-MC2 Audio sync.** Align the grouped clips by **audio cross-correlation** —
  extract each clip's audio, find the offset that maximizes correlation against a
  reference, and store a per-clip time offset. Report a confidence; fall back to a
  manual/marker offset when correlation is weak.
- **R-MC3 Audio-only sources as primary audio.** Some "video" inputs are actually
  **audio-only** files from external mic recorders, and are almost always the
  **primary audio**. An audio-only member of a group is treated as the sync
  reference **and** the master audio; the cameras sync to it and take their audio
  from it (camera audio used only as a sync aid / fallback).
- **R-MC4 Frame-rate mismatch.** Group members commonly differ — 29.97 vs 30,
  59.97 vs 60, etc. Sync must be **best-effort across differing rates**: align on
  real (seconds) time, not frame counts; conform each angle to the project fps on
  output (retime/resample as needed); never assume integer or equal fps.
- **R-MC5 Angle selection.** With a synced group, the cut can **cut between
  angles** at chosen times over the shared timeline (FCP-style angle switching),
  while the master audio runs continuously underneath.
- **R-MC6 Handoff.** Express synced groups in the [editor handoff](editor-handoff.md):
  in the JSON manifest as group + per-angle offsets, and ideally as an FCPXML
  `mc-clip` / multicam asset so FCP receives a real multicam clip. (FCPXML
  multicam is complex — may be a later milestone; a synced-but-flat timeline is an
  acceptable first cut.)

## 3. Known hard problems (flag, don't hand-wave)

- **Sample-accurate sync + drift.** Audio correlation gives a good offset, but
  clocks drift over long takes; a single offset may not hold for a 30-min clip.
  May need periodic re-sync or a small rate correction.
- **Variable / non-integer frame rates** and dropped frames make frame-based
  alignment unreliable — hence the seconds-based approach in R-MC4.
- **Silent / non-overlapping audio.** Correlation fails when a camera didn't
  record usable audio or the windows don't overlap; needs a manual fallback.

## 4. Likely implementation (non-binding)

- A sync tool (ffmpeg to extract mono audio per clip + a cross-correlation step)
  that emits per-clip offsets + confidence into the group manifest.
- The skill drives grouping (proposing groups from filenames/timestamps/folders),
  confirms with the user, runs sync, then designs angle cuts.
- Deferred until [multiple-sources](multiple-sources.md) lands, since a group is a
  subset of the source pool.

## 5. Open questions / follow-ups

- How to propose groups automatically (folder structure? creation timestamps?
  filename patterns?) vs. always ask.
- Cross-correlation library/approach (ffmpeg `axcorrelate`, a small DSP step, or
  an external tool) and the confidence threshold for auto-accept.
- Whether v1 targets true FCPXML multicam assets or just a synced flat timeline.

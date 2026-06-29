# Multi-cam Editing

Status: **Mostly shipped** (VS-27/29/30/31/32). The **audio sync tool**
([`multicam-sync.md`](multicam-sync.md): `tools/sync-multicam.mjs` +
`tools/multicam.mjs`, 100% tested), **group proposal** (`propose-groups`),
**angle switching** (`expandMulticamGroup` → a synced flat-timeline cut spec
driven from the skill, exported with a continuous master-audio track + FCPXML),
and **drift detection + retime correction** are all built. **Remaining:** a true
FCPXML `mc-clip` multicam asset (VS-33) and applying the per-angle drift retime on
export. Builds on [`multiple-sources.md`](multiple-sources.md): a multicam group
is a labeled subset of the source pool that is **time-aligned** so the cut can
switch angles.

> **Early concept.** Design intent; most of it is built (sync, grouping, angle
> switching, drift correction). The true FCPXML multicam *asset* is the last
> milestone.

## 1. Purpose

Mirror the Final Cut Pro multicam workflow: identify which sources cover the
**same moment from different angles**, **sync them** (usually by audio), then let
the cut **switch angles** over a shared timeline. Crucially, the best audio is
often a **separate recording**, and frame rates frequently **don't match**.

## 2. Requirements

The audio-sync requirements (R-MC2/3/4) are **shipped** and specified in detail
in [`multicam-sync.md`](multicam-sync.md); the status marker on each below is the
quick view.

- **R-MC1 Grouping.** *(Shipped — explicit groups + `propose-groups` auto-proposal
  by folder/timestamps/filename; skill confirmation flow is VS-29.)* The user (or
  the AI, with confirmation) labels a set of sources as a **multicam group**
  representing one continuous event from multiple cameras/recorders. A project may
  have several groups.
- **R-MC2 Audio sync.** *(Shipped — see [`multicam-sync.md`](multicam-sync.md).)*
  Align the grouped clips by **audio cross-correlation** — extract each clip's
  audio, find the offset that maximizes correlation against a reference, and store
  a per-clip time offset. Report a confidence; fall back to a manual/marker offset
  when correlation is weak.
- **R-MC3 Audio-only sources as primary audio.** *(Shipped.)* Some "video" inputs
  are actually **audio-only** files from external mic recorders, and are almost
  always the **primary audio**. An audio-only member of a group is treated as the
  sync reference **and** the master audio; the cameras sync to it and take their
  audio from it (camera audio used only as a sync aid / fallback).
- **R-MC4 Frame-rate mismatch.** *(Shipped — seconds-based alignment; output
  conform deferred to the handoff.)* Group members commonly differ — 29.97 vs 30,
  59.97 vs 60, etc. Sync must be **best-effort across differing rates**: align on
  real (seconds) time, not frame counts; conform each angle to the project fps on
  output (retime/resample as needed); never assume integer or equal fps.
- **R-MC5 Angle selection.** *(Shipped — `expandMulticamGroup` turns angle
  switches into a cut spec; driven from the skill.)* With a synced group, the cut
  can **cut between angles** at chosen times over the shared timeline (FCP-style
  angle switching), while the master audio runs continuously underneath.
- **R-MC6 Handoff.** *(Shipped as a synced flat timeline; true FCPXML multicam
  asset deferred to VS-33.)* Synced groups feed the
  [editor handoff](editor-handoff.md) as silent video angle-segments over a
  continuous master-audio track — the manifest carries the `audioTrack`, the
  `rebuild.sh` muxes it under the switching angles, and the FCPXML attaches it on
  a connected audio lane. A true FCPXML `mc-clip` / multicam asset (so FCP shows a
  real multicam clip in the angle viewer) is the remaining milestone.

## 3. Known hard problems (how they're handled)

The VS-19/VS-27 deep research confirmed the technique and how to face each — full
findings + citations in [`multicam-sync.md` §7](multicam-sync.md#7-research-findings--citations).

- **Sample-accurate sync + drift.** Audio correlation gives a good offset, but
  clocks drift over long takes; a single offset may not hold for a 30-min clip.
  *Handled:* drift is **detected, flagged, and a retime correction computed**
  (linear `slope·t + intercept` fit → ppm + `driftWarning` + `rateCorrection` +
  start-anchored `correctedOffsetSeconds`). **Applying** the retime on export
  lands with VS-29.
- **Variable / non-integer frame rates** and dropped frames make frame-based
  alignment unreliable. *Handled:* all alignment is **seconds-based** via the
  audio sample clock (R-MC4), so mismatched rates need no special case.
- **Silent / non-overlapping audio.** Correlation fails when a camera didn't
  record usable audio or the windows don't overlap. *Handled:* low confidence →
  `unsynced` → a **manual offset** (`--manual <id>=<sec>`) fallback.

## 4. Implementation

- **Shipped:** the sync tool — `tools/sync-multicam.mjs` (ffmpeg mono extract +
  the run) over `tools/multicam.mjs` (pure FFT/GCC-PHAT cross-correlation,
  confidence gate, drift fit + retime correction, group-manifest, angle-cut +
  `expandMulticamGroup` math, 100% unit-tested). Emits `multicam.json`. Group
  proposal in `tools/propose-groups.mjs` + `tools/multicam-groups.mjs`. The skill
  drives grouping → sync → angle switching; the [editor handoff](editor-handoff.md)
  carries the continuous master-audio track (manifest `audioTrack` + `rebuild.sh`
  mux + FCPXML connected audio lane). See [`multicam-sync.md`](multicam-sync.md).
- **Deferred:** a true FCPXML `mc-clip` multicam asset (VS-33) and applying the
  per-member drift `rateCorrection` retime on export.

## 5. Open questions / follow-ups

- ~~How to propose groups automatically (folder structure? creation timestamps?
  filename patterns?) vs. always ask.~~ **Decided/shipped (VS-31):**
  `propose-groups` suggests by folder / overlapping recording windows / filename
  pattern (`auto` prefers timestamps), and the user confirms.
- ~~Cross-correlation approach + confidence threshold.~~ **Decided:** pure-JS FFT
  cross-correlation, normalized-peak gate (0.80 accept / 0.50 manual).
- Whether v1 targets true FCPXML multicam assets or just a synced flat timeline.
  *(Deferred to the handoff follow-up; a synced flat timeline is the first cut.)*

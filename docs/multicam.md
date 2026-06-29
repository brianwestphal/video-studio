# Multi-cam Editing

Status: **Shipped** (VS-27/29/30/31/32/33). The **audio sync tool**
([`multicam-sync.md`](multicam-sync.md): `tools/sync-multicam.mjs` +
`tools/multicam.mjs`, 100% tested), **group proposal** (`propose-groups`),
**angle switching** (`expandMulticamGroup` → a synced flat-timeline cut spec
driven from the skill, exported with a continuous master-audio track + FCPXML),
**drift detection + retime correction** (applied on export), and a **true FCPXML
`mc-clip` multicam asset** (`export-multicam-fcpxml`, the live re-cuttable angle
clip) are all built. Builds on [`multiple-sources.md`](multiple-sources.md): a
multicam group is a labeled subset of the source pool that is **time-aligned** so
the cut can switch angles.

> **Early concept.** Design intent, now built end to end. The one caveat: the
> FCPXML multicam asset is generated structurally to spec but has **not** been
> round-trip-validated against a real Final Cut Pro import in this environment —
> see the manual test plan.

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
- **R-MC6 Handoff.** *(Shipped — both the flat timeline and a true FCPXML multicam
  asset.)* Synced groups feed the [editor handoff](editor-handoff.md) two ways:
  (a) as a **synced flat timeline** — silent video angle-segments over a
  continuous master-audio track (manifest `audioTrack`, `rebuild.sh` mux, FCPXML
  connected audio lane); and (b) as a **true FCPXML `<mc-clip>` multicam asset**
  (`export-multicam-fcpxml`, VS-33) — a `<media>`/`<multicam>` of per-angle
  `<mc-angle>` tracks referencing the original media, with one `<mc-clip>` per
  angle switch, so FCP shows a live multicam clip re-cuttable in the angle viewer.
  The spine `<mc-clip>`s are laid on **exact frame boundaries** (offset/duration
  in whole frames, so consecutive clips abut precisely and the last ends on the
  sequence duration) — independent per-clip second→frame rounding otherwise left
  ±1-frame gaps/overlaps that FCP mis-positions at non-integer rates (VS-36). The
  master audio plays from a **connected clip on lane -1** of the first mc-clip
  (the same path the flat export uses) and the spine mc-clips select **video
  only** — routing audio through an `mc-source srcEnable="audio"` imported silent
  in FCP (VS-36). The audio asset's `duration` is declared **sample-exactly** (not
  video-frame-quantized), or FCP rejects the full-length audio edit as "no
  respective media" (VS-36). To preview the cut without FCP,
  **`render-multicam-preview`** renders the same group + `--switch` points to a
  flat MP4 (the synced angle cuts with the master audio underneath) for a
  side-by-side comparison.

  **FCP import gotchas (validated against a real import, VS-36):**
  - The generated `.fcpxml` validates against FCP's bundled DTD — when FCP is
    installed you can check it directly:
    `xmllint --noout --dtdvalid "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_10.dtd" <file>.fcpxml`
    (copy the DTD somewhere without spaces in the path first, or entity resolution
    fails). A DTD-valid file that still mis-imports is almost always a **media**
    problem, not a structure problem.
  - **Source-media compatibility is on you.** FCP's FCPXML importer rejects some
    files other tools read fine — notably **Pro Tools / Broadcast Wave** WAVs with
    a non-standard 40-byte `fmt ` chunk and extra metadata chunks
    (`bext`/`minf`/`elm1`/`regn`/`umid`): every edit referencing them imports as
    "Invalid edit with no respective media." Re-encode to a canonical `fmt`+`data`
    WAV (`ffmpeg -fflags +bitexact -i in.wav -map_metadata -1 -c:a pcm_s16le
    -ac 2 -ar 48000 out.wav`) and reference that. (Follow-up: have the toolkit
    detect/normalize this on sync/export — see the Hot Sheet.)

## 3. Known hard problems (how they're handled)

The VS-19/VS-27 deep research confirmed the technique and how to face each — full
findings + citations in [`multicam-sync.md` §7](multicam-sync.md#7-research-findings--citations).

- **Sample-accurate sync + drift.** Audio correlation gives a good offset, but
  clocks drift over long takes; a single offset may not hold for a 30-min clip.
  *Handled:* drift is **detected, flagged, a retime correction computed** (linear
  `slope·t + intercept` fit → ppm + `driftWarning` + `rateCorrection` +
  start-anchored `correctedOffsetSeconds`) **and applied on export** — a drifting
  angle segment is time-stretched (`setpts`) so its source span fills its timeline
  slot (VS-30/33).
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
  mux + FCPXML connected audio lane) and applies the drift retime (`setpts`). The
  true FCPXML `<mc-clip>` multicam asset is `tools/export-multicam-fcpxml.mjs` over
  `buildMulticamFcpxml` in `tools/fcpxml.mjs`. A flat watchable preview of the same
  angle cut is `tools/render-multicam-preview.mjs` (ffmpeg I/O over the tested
  `resolveAngleCuts`). See [`multicam-sync.md`](multicam-sync.md).
- **Caveat:** the multicam FCPXML asset is generated to the documented schema but
  not yet round-trip-validated against a real FCP import here (manual test).

## 5. Open questions / follow-ups

- ~~How to propose groups automatically (folder structure? creation timestamps?
  filename patterns?) vs. always ask.~~ **Decided/shipped (VS-31):**
  `propose-groups` suggests by folder / overlapping recording windows / filename
  pattern (`auto` prefers timestamps), and the user confirms.
- ~~Cross-correlation approach + confidence threshold.~~ **Decided:** pure-JS FFT
  cross-correlation, normalized-peak gate (0.80 accept / 0.50 manual).
- Whether v1 targets true FCPXML multicam assets or just a synced flat timeline.
  *(Deferred to the handoff follow-up; a synced flat timeline is the first cut.)*

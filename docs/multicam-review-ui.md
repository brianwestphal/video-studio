# Multi-cam review UI — resolve low-confidence auto-cuts by hand

Cross-references: [`multicam-auto-cut.md`](multicam-auto-cut.md) (the selector that
emits `switches.json` + the per-switch review signal, R-AC9), [`multicam.md`](multicam.md)
(the `--switches` export handoff), [`visual-saliency.md`](visual-saliency.md) (where the
vision `confidence` comes from).

## 1. Problem

The auto multi-cam selector (VS-46/47/62) is right most of the time, but some cuts are
genuine coin-flips: two angles score within a hair of each other, or the vision model
wasn't sure what it was looking at. Rather than silently pick, surface **only those
cuts** to the user in a lightweight local web UI, show the candidate angles with a bit
of context on either side, and let the user choose. The choice is written back to the
same hand-editable `switches.json` the exporters already read (R-AC7), so review is an
optional polish pass, not a new required step.

Chosen over a pure hand-edit of `switches.json` because comparing angles needs to *see*
the footage; a JSON diff can't tell you which of two near-tied angles looks better.

## 2. What counts as "low confidence" (shipped — R-AC9)

`autoCut` already emits, per switch, a `runnerUp`, a `confidence` in `[0,1]`, and a
`flagged` boolean (see [`multicam-auto-cut.md`](multicam-auto-cut.md) §5). Two distinct
failure modes drive it, and **either** trips the flag (err toward over-asking):

- **Near-tie** — the normalized score margin between the chosen angle and the runner-up
  at the cut window is below `reviewMarginThreshold` (default 0.15). The pick was close.
- **Unsure vision** — the chosen window's saliency `confidence` (the vision model's own
  self-reported certainty, from `parseVisionReply`) is below `reviewConfidenceThreshold`
  (default 0.6). The model didn't trust what it saw.

Both thresholds are `autoCut` params, tunable per run.

## 3. Flow

```
propose-switches → switches.json (+ flagged rationale)
        │
        ▼
review-switches multicam.json --switches switches.json [--audio-events … --saliency …]
        │  starts a local HTTP server, opens the browser
        ▼
browser: for each flagged segment — candidate angle previews (±2s context), pick one
        │  (optional) Re-propose downstream → autoCut(locks=picks) re-flows the rest
        │  POST the choice back
        ▼
switches.json rewritten in place (switches.json.bak kept) + a choice/edit history log
        │
        ▼
prints the ready `export-multicam-fcpxml … --switches switches.json` line
```

## 4. Requirements

- **R-RUI1 — Launch.** A thin CLI `tools/review-switches.mjs <multicam.json> --switches
  <switches.json> [--audio-events <p>] [--saliency <p>] [--port <n>] [--all]` starts a
  local HTTP server and opens the browser to the review page. No network egress;
  localhost only. `--audio-events` + `--saliency` enable the re-propose button (R-RUI7).
- **R-RUI2 — Flag source.** The UI surfaces exactly the switches with `flagged: true`
  (R-AC9); a `--all` flag can show every switch. Nothing is auto-changed without a user
  choice.
- **R-RUI3 — Context previews.** For each flagged segment the UI shows the candidate
  angles (the chosen + `runnerUp`, and optionally all covering angles) as short clips
  covering the segment **± 2 s** on either side, **pre-extracted** with ffmpeg into a
  temp dir and served locally (no seeking in the full source files).
- **R-RUI4 — Choice.** The user picks the winning angle per segment (or keeps the auto
  pick). Picks are applied to a working copy; nothing is destructive until saved.
- **R-RUI5 — Write-back + history.** On save, `switches.json` is rewritten **in place**
  after copying the prior version to `switches.json.bak`, and every change is appended to
  a **choice/edit history** (segment time, from → to, timestamp, and an optional
  user `note`) — persisted so the record of *what was overridden and why* survives across
  sessions. The `switches` list stays the plain `{ atSeconds, memberId }` shape the
  exporters read.
- **R-RUI6 — Handoff.** After save the CLI prints the ready
  `export-multicam-fcpxml … --switches …` / `render-multicam-preview … --switches …` line.
- **R-RUI8 — Interactive playback.** The candidate clips do **not** auto-play the whole
  page. Each flagged segment has its own transport (play/pause + seek + time) that drives
  all of that segment's angle clips **in lockstep** off a leader clock (drift-corrected),
  and loops the segment. Only **one segment plays at a time** — starting one pauses any
  other — and within the playing segment exactly **one clip is unmuted** (audio focus,
  defaults to the current pick; a per-clip Audio toggle moves it), so audio is always
  single-source. Any clip can be viewed **fullscreen** for close inspection. Pick, audio
  focus, and fullscreen are distinct per-clip controls. Because previews carry ±context
  on both sides, the scrubber marks the **section of interest** — a highlighted band over
  `[atSeconds, endSeconds]` (the shot this cut introduces) with a tick at the exact cut —
  so overlapping neighbouring previews are still distinguishable; the section time range
  is shown in the segment header. (I/O — manual-test-plan §13.)
- **R-RUI9 — Whole-video assembled preview.** A lazily-loaded ("Load full-video preview")
  timeline plays the **entire** assembled multi-cam edit and shows the full `[0, timelineEnd]`
  as a bar of **per-switch blocks colored by angle**, with **flagged** sections marked and
  a scrubbable playhead. Playback is a **client-side multi-cam player**: each angle's source
  is served with HTTP **Range** (`/source/<id>`), the angles are stacked, and only the
  **active** angle decodes — at each cut the active angle **swaps** per the assembled switch
  list (`/assembled`) with the user's in-progress picks applied by switch index. Changing a
  pick **recolors the bar and swaps the playing angle live**; timeline playback and the
  per-segment players are mutually exclusive (single audio). Rough by design — angle swaps
  cause a brief seek stall, and tiny rate corrections are ignored (the ±context per-segment
  previews remain the accurate close-inspection tool). (I/O — manual-test-plan §13.)
- **R-RUI10 — Manual review editing + docked timeline.** The user can shape the review
  set and cuts by hand (VS-74): **(a) force-add** any cut — even an unflagged one — into the
  review list (`reviewSegments` `forceKeys`, keyed by `atSeconds` so it survives index
  shifts; server `/add-review`); **(b) split** the shot at the playhead into two
  independently-choosable regions (`splitSwitch` inserts a same-angle, `flagged`+`manual`
  cut into the covering region, rejecting a non-positive time, before-first-cut, or a cut
  already within epsilon; server `/split`, logged to history on save); and **(c)** the
  whole-video timeline (R-RUI9) is **docked as a collapsible drawer that expands from the
  fixed nav bar** (a "Timeline" toggle, lazy-loaded), reachable without scrolling to the
  top. Clicking a bar block scrubs so the playhead lands in it; Split/Add operate on the
  cut under the playhead. `forceKeys` + `splitSwitch` are pure + unit-tested; the drawer,
  buttons, and endpoints are I/O (manual). Manual splits are **not** preserved by a
  re-propose (that regenerates the auto cuts from locks and is meant to run *before* manual
  editing). (manual-test-plan §13.)
- **R-RUI7 — Downstream re-evaluation.** A confirmed user choice **re-influences the
  subsequent auto picks**: `autoCut` accepts `locks` (user-confirmed
  `{ atSeconds, memberId }`) that are pinned and let the selection re-flow around them,
  and a soft **shot-type variety** penalty (`shotTypeRepeatPenalty`) keeps the edit off
  two similar-sized shots in a row. Shot size comes from `shotTypeOf` — an explicit
  vision `shotType` (wide / medium / close) or a label hint — best-effort, no penalty
  when unknown. *(Model shipped VS-66; wiring the review UI's save to re-propose
  downstream is a follow-up, VS-67.)*

## 5. Testing

Per the project split: the **pure** pieces are unit-tested to 100% — the flag signal
(R-AC9, in `multicam-autocut.test.ts`), and the review model to be extracted for
R-RUI4/5/7 (flagged-segment derivation, preview time-windows, apply-choice + history,
re-evaluation). The **I/O shell** — the HTTP server, the browser page, and the ffmpeg
preview extraction — is out of automated scope and lives in
[`manual-test-plan.md`](manual-test-plan.md) (like the other pipeline tools).

## 6. Status / follow-ups

- **R-AC9 — the review signal — is shipped (VS-63).** `autoCut` flags near-tie /
  low-vision-confidence switches with a `runnerUp` + `confidence`.
- **R-RUI1–R-RUI6 (the web UI) — shipped (VS-65).** `tools/review-switches.mjs` +
  the pure `tools/review-model.mjs` (100% unit-tested: flag filtering, candidate angles,
  preview windows, apply-choice + history). The HTTP server, page, and ffmpeg preview
  extraction are manual ([`manual-test-plan.md`](manual-test-plan.md) §13).
- **R-RUI8 (interactive playback) — shipped (VS-71).** The page gives each flagged cut a
  synchronized per-segment transport (play/pause/seek, drift-corrected, segment-looping),
  plays only one segment at a time with a single unmuted audio-focus clip, and lets any
  clip go fullscreen. Preview clips now retain audio (`extractClip` dropped `-an`, keeps
  a downscaled video + mono audio). The scrubber highlights the section-of-interest band
  (the shot the cut introduces) so overlapping previews stay distinguishable (VS-72).
  Manual ([`manual-test-plan.md`](manual-test-plan.md) §13).
- **R-RUI9 (whole-video assembled preview) — shipped (VS-73).** A "Load full-video preview"
  timeline plays the whole assembled edit via a client-side multi-cam player (per-angle
  sources served with HTTP Range, only the active angle decodes, swapping at each cut per
  the current switches with in-progress picks applied) and a bar of angle-colored blocks
  with flagged sections marked + scrubbing; pick changes recolor + re-angle live. `/source`
  (Range) + `/assembled` endpoints. Manual ([`manual-test-plan.md`](manual-test-plan.md) §13).
- **R-RUI10 (manual review editing + docked timeline) — shipped (VS-74).** Force-add any
  cut to review (`reviewSegments` `forceKeys`, `/add-review`), split a shot at the playhead
  (`splitSwitch`, `/split`), and the timeline is a collapsible drawer off the nav bar. Pure
  `forceKeys`/`splitSwitch` unit-tested (`review-model.test.ts`); drawer/buttons/endpoints
  manual ([`manual-test-plan.md`](manual-test-plan.md) §13.18-13.21).
- **R-RUI7 (downstream re-evaluation) — shipped (VS-66 model + VS-67 UI).** `autoCut`
  honors `locks` and applies a shot-type variety penalty (`shotTypeRepeatPenalty`); shot
  size from `shotTypeOf` (explicit vision `shotType` or a label hint). Unit-tested. The
  review UI wires it via an opt-in **Re-propose downstream** button (shown when
  `--audio-events` + `--saliency` are supplied): it re-runs `autoCut` with the user's
  confirmed picks as locks so the still-auto cuts re-flow, previewing in the page;
  nothing is written until Save (manual-test-plan §13.7–13.8).

### Kerfjs client migration (VS-120)

The browser client is a typed kerfjs bundle (`ui/review-entry.tsx` and
`ui/review-components.tsx`) served by the existing local HTTP server. Reactive header and
segment state use one mount; dynamic segments/candidates carry stable keys and review
actions delegate from the stable app root. Candidate and assembled-player video nodes live
inside explicit preserved ownership boundaries so synchronized playback, seek state, and
fullscreen survive reactive updates. Server endpoints and persisted file formats are
unchanged.

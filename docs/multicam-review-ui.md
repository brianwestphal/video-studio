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
        │  POST the choice back
        ▼
switches.json rewritten in place (switches.json.bak kept) + a choice/edit history log
        │
        ▼
prints the ready `export-multicam-fcpxml … --switches switches.json` line
```

## 4. Requirements

- **R-RUI1 — Launch.** A thin CLI `tools/review-switches.mjs <multicam.json> --switches
  <switches.json> [--audio-events <p>] [--saliency <p>] [--port <n>]` starts a local
  HTTP server and opens the browser to the review page. No network egress; localhost only.
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
- **R-RUI7 — Downstream re-evaluation.** A confirmed user choice **re-influences the
  subsequent auto picks**: after locking a segment to an angle, later still-auto cuts are
  re-evaluated so the edit doesn't, e.g., hold a similar-looking shot too long across the
  user's pick (a shot-*type* variety penalty, not just same-angle). Depends on a
  shot-type signal per window — see follow-ups.

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
- **R-RUI1–R-RUI6 (the web UI itself) — design only.** Build tracked in **VS-65**.
- **R-RUI7 (downstream re-evaluation) — design only.** Needs a per-window shot-type
  signal (wide / medium / close) to penalize consecutive similar shots; tracked in
  **VS-66** (also revisits the `wRepeat` variety idea from `multicam-auto-cut.md` §3).

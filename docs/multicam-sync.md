# Multi-cam Audio Sync

Status: **Partial** (VS-27). The **sync tool** is shipped —
`tools/sync-multicam.mjs` (ffmpeg I/O) + `tools/multicam.mjs` (pure DSP +
manifest math, unit-tested to 100%). Angle-switching is resolved by the pure
`resolveAngleCuts`; wiring it through the skill + editor handoff and emitting a
true FCPXML multicam asset are **deferred** (see [Deferred](#6-deferred--follow-ups)).

This is the concrete, audio-sync half of the broader [`multicam.md`](multicam.md)
design. A multicam group is a labeled subset of the [source pool](multiple-sources.md)
that is **time-aligned** so a cut can switch angles over a shared timeline.

## 1. Purpose

Take a set of clips that cover **one event from several cameras/recorders** and
**time-align them by their audio**, emitting a group manifest (`multicam.json`)
with a per-member **offset + confidence**. The best audio is often a **separate
recording** (a field recorder / external mic), and the cameras' frame rates
frequently **don't match** — both are first-class here.

## 2. Technique (validated by deep research)

The VS-19/VS-27 ask was to "do deep research… use 3rd-party tools if needed."
That research (fan-out web search + adversarial verification) **confirmed** the
design's audio-cross-correlation approach and pinned down the specifics below.
Key sources are cited in [§7](#7-research-findings--citations).

- **FFT cross-correlation of a conditioned mono signal.** Downmix each clip to
  mono and resample to a common rate (ffmpeg), then cross-correlate in the
  frequency domain via the convolution theorem — `IFFT(FFT(a)·conj(FFT(b)))`,
  `O(N log N)`. The argmax lag, divided by the sample rate, is the offset in
  **seconds**. This is the same primitive ffmpeg `axcorrelate` and
  `scipy.signal.correlate(method="fft")` use; doing it ourselves yields a single
  global offset + confidence instead of `axcorrelate`'s per-window time series.
- **Pure-JS core, ffmpeg only for I/O.** The correlation math is small and
  language-agnostic, so it lives in pure, unit-tested JS (`tools/multicam.mjs`).
  ffmpeg is used only to decode/downmix/resample the audio (and, if drift
  correction is ever added, to retime). No third-party sync binary is required.
- **Conditioning + method.** Mono downmix + resample is universal. The
  correlation **feature** is tunable: the default **log-energy-style envelope**
  (rectify + box-smooth, then mean-remove) is robust to per-mic
  gain/frequency-response differences at low SNR; `--feature raw` uses the
  waveform directly for maximum precision on clean audio; `--feature phat` runs
  **GCC-PHAT** — the cross-power spectrum is phase-whitened (each bin divided by
  its magnitude), giving a much sharper, more noise-immune peak for very low SNR
  (the textbook Knapp & Carter method).
- **Sub-sample precision.** The integer peak is refined by **parabolic
  interpolation** of the three correlation samples straddling it, so offsets are
  accurate below one sample at the analysis rate (matters for tight lip-sync). On
  by default; `--no-interpolate` falls back to integer-sample offsets.

## 3. Requirements

- **R-MCS1 Grouping (explicit).** The user names ≥2 clips as a multicam group
  (`--group-id`). Automatic group proposal (from folders/timestamps/filenames)
  is deferred — v1 syncs an explicit, labeled set.
- **R-MCS2 Audio cross-correlation.** Align members by FFT cross-correlation
  against a reference, storing a per-member **offset (seconds)** + **confidence**
  (normalized correlation peak in `[0,1]`, or peak distinctness `1 − second/peak`
  for GCC-PHAT) + a **peak-to-second-peak ratio**. The offset is refined to
  **sub-sample precision** (parabolic peak interpolation; `--no-interpolate` to
  disable), and the correlation can run amplitude (`envelope`/`raw`) or
  phase-whitened (`phat`, GCC-PHAT) via `--feature`.
- **R-MCS3 Confidence gate → manual fallback.** Disposition by confidence:
  `auto` ≥ `--accept` (0.80), `review` in between, **`unsynced`** < `--reject`
  (0.50). An `unsynced` member is reported with a re-run hint; `--manual
  <id>=<seconds>` supplies the offset by hand (the silent / non-overlapping-audio
  case). User-supplied offsets are labeled `manual`.
- **R-MCS4 Audio-only member = reference + master audio (R-MC3).** A member with
  no video stream (probed via ffprobe) is treated as the **sync reference** AND
  the **master audio**. With several audio-only members, the longest is the
  reference; otherwise the longest member overall anchors the group at offset 0.
- **R-MCS5 Seconds, never frames (R-MC4).** All alignment is in seconds via the
  audio sample clock, so **mismatched / non-integer frame rates** (29.97 vs 30,
  59.97 vs 60) need no special handling. Each member keeps its own fps; the group
  records a **project fps** (default: the highest member fps) to conform to on
  output.
- **R-MCS6 Drift detection (R-MC, "hard problem").** For long takes (longer than
  `--drift-min`, default 600 s) the offset is measured on a window near the start
  and near the end of the clip and a line `offset(t) = slope·t + intercept` is
  fit; the **drift rate (ppm)** is recorded and a member is flagged
  `driftWarning` past `DRIFT_WARN_PPM` (100 ppm). v1 **detects and flags** drift;
  it does not yet retime to correct it (deferred).
- **R-MCS7 Group manifest.** Emit `multicam.json` (`{ groups: [...] }`): per
  group an `id`, `projectFps`, `referenceId`, `masterAudioId`, and `members`
  (`id`, `path`, `kind`, `fps`, `durationSeconds`, `offsetSeconds`, `confidence`,
  `peakRatio`, `sync`, `driftPpm`, `driftWarning`). See [§5](#5-manifest-schema).
- **R-MCS8 Angle resolution.** Given angle **switch points** over the shared
  timeline, `resolveAngleCuts` produces segments
  `{ memberId, timelineIn/Out, sourceIn/Out }` — `sourceIn = timelineIn − offset`
  — ready for the [editor handoff](editor-handoff.md). Wiring this into the skill
  + FCPXML is deferred.

## 4. CLI

```
sync-multicam <clip…> [options]
  --group-id <id>           group id (default: "group")
  --project-fps <n>         output fps (default: highest member fps)
  --sample-rate <hz>        mono analysis rate (default: 8000)
  --feature <envelope|raw|phat>  correlation feature (default: envelope;
                            phat = GCC-PHAT phase-whitened, noise-robust)
  --max-offset <sec>        max plausible start offset to search (default: 300)
  --accept <0..1>           auto-accept confidence (default: 0.8)
  --reject <0..1>           manual-fallback confidence (default: 0.5)
  --drift-min <sec>         estimate drift on clips longer than this (default: 600)
  --window <sec>            drift-probe window length (default: 30)
  --no-interpolate          disable sub-sample (parabolic) peak refinement
  --manual <id>=<sec>       force a member's offset (silent/non-overlapping audio)
  --out <multicam.json>     output path (default: ./multicam.json)
```

Member ids are the disambiguated filename slugs from
[`sources.mjs`](../tools/sources.mjs) (`assignSourceIds`), so they match the
multi-source manifest.

## 5. Manifest schema

```jsonc
{
  "groups": [
    {
      "id": "ceremony",
      "projectFps": 30,
      "referenceId": "recorder",      // sync anchor (offset 0)
      "masterAudioId": "recorder",    // audio for the cut (audio-only member if any)
      "members": [
        {
          "id": "recorder", "path": "/…/recorder.wav", "kind": "audio",
          "fps": null, "durationSeconds": 1800,
          "offsetSeconds": 0, "confidence": 1, "peakRatio": null,
          "sync": "reference", "driftPpm": 0, "driftWarning": false
        },
        {
          "id": "cam-a", "path": "/…/cam-a.mov", "kind": "video",
          "fps": 29.97, "durationSeconds": 1795,
          "offsetSeconds": 2.5,         // cam-a started 2.5 s after the reference
          "confidence": 0.92, "peakRatio": 16.1,
          "sync": "auto", "driftPpm": 12, "driftWarning": false
        }
      ]
    }
  ]
}
```

**Offset convention.** `offsetSeconds` is where the member's first sample sits on
the shared (reference) timeline: `group_time = member_local_time + offsetSeconds`.
Positive ⇒ the member started **later** than the reference.

## 6. Deferred / follow-ups

- **Drift correction (retime/re-clock).** v1 flags drift; correcting it (ffmpeg
  `atempo`/resample, or a two-stage start/end re-clock à la PluralEyes) is a
  follow-up.
- **Automatic group proposal** from folders / creation timestamps / filename
  patterns (v1 requires an explicit group).
- **Skill + editor-handoff + FCPXML multicam.** Drive grouping/sync from the
  skill, express groups in the handoff manifest, and emit a true FCPXML
  `mc-clip` / multicam asset (a synced flat timeline is the acceptable first cut).

Shipped since the first cut (VS-32): **sub-sample precision** (parabolic peak
interpolation) and the **GCC-PHAT** (`--feature phat`) phase-whitened feature.

## 7. Research findings + citations

The deep research compared `axcorrelate`, FFT cross-correlation (scipy/numpy),
GCC-PHAT, and dedicated tools (PluralEyes, audalign, BBC `audio-offset-finder`),
adversarially verifying each claim. Highlights that shaped this design:

- **FFT cross-correlation is the field-standard primitive** (`O(N log N)` via the
  convolution theorem) and a **pure-JS implementation on downsampled mono is
  viable** — the algorithm is identical to `axcorrelate` / `scipy`; ffmpeg is
  still needed for decode/downmix/resample and any retime.
  ([SciPy docs](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.correlate.html),
  [Apple US Patent 8,621,355](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8621355),
  [GCC-PHAT](https://github.com/MinAungThu/GCC-PHAT))
- **Confidence gating is how every tool handles silent / non-overlapping audio**
  — none auto-solve it; a low normalized-peak / z-score falls back to manual.
  Concrete gates: normalized peak **>0.80 accept / <0.50 unreliable**
  (sync-offset-tool); BBC z-score **>10 / <5** needs manual check. We use the
  normalized-peak 0.80/0.50 gate.
  ([gmipf/sync-offset-tool](https://github.com/gmipf/sync-offset-tool),
  [BBC audio-offset-finder](https://pypi.org/project/audio-offset-finder/))
- **Seconds-based alignment sidesteps variable/non-integer fps** — surveyed tools
  do no frame-rate logic; the lag is a sample index ÷ sample rate.
  ([audalign](https://github.com/benfmiller/audalign/))
- **Drift over long takes needs more than one offset** — a linear `slope·t +
  intercept` fit with the **midpoint offset** makes the residual symmetric; a
  single midpoint offset suffices for angle-switching cuts, while tight lip-sync
  past ~30 min needs a retime. PluralEyes does end-to-end speed-matching ("drift
  corrected" output).
  ([Apple patent](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8621355),
  [PluralEyes/DesignTrek](http://www.designtrek.com/quickly-sync-audio-and-video-and-correct-drift-with-pluraleyes))
- **Envelope vs raw waveform** — an amplitude/log-energy envelope is more robust
  at low SNR (secondary-camera mics); this was the one split-vote claim (a
  PHAT-whitened raw signal is also low-SNR robust), so the feature is a tunable
  (`--feature`) defaulting to envelope.

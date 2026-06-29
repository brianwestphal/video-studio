# Non-speech audio events (design / requirements)

Status: **Tier 1 shipped (VS-44)** — loudness envelope, onsets, quiet, and
vocal-vs-instrumental sectioning (gated by the whisper transcript). Tier 2
(spectral descriptors + section novelty) and Tier 3 (per-singer diarization,
instrument ID, stems) are deferred — see §7. Feeds the angle-selection model in
[`multicam-auto-cut.md`](multicam-auto-cut.md) (VS-43/46). Cross-referenced from
[`multicam.md`](multicam.md).

**Implementation:** pure analysis in [`../tools/audio-events.mjs`](../tools/audio-events.mjs)
(`rmsEnvelope`, `detectOnsets`, `vocalSpans`, `sectionize`, `buildAudioEvents`,
`wordsFromWhisper`; 100% unit-tested, `tests/audio-events.test.ts`); the ffmpeg
extraction + whisper read + file write in the thin CLI
[`../tools/analyze-audio-events.mjs`](../tools/analyze-audio-events.mjs)
(manual-test-plan §8). On the BYAM master it returns a quiet intro/outro, the
instrumental body, 629 onsets, and — with `--transcript` — vocal sections.

## 1. Why

The pipeline today understands **speech** (whisper word-level timing) but is deaf
to everything else in the audio: guitar riffs, instrumental vs vocal sections,
which singer is leading, accents and dynamics. For a music multi-cam that makes
the editor cut to the wrong thing — it can't favor the guitar during a riff or
hold on the person who's actually singing because it doesn't know those moments
exist. This doc specifies an **audio-events pass** that produces a typed,
describable timeline of non-speech/musical events (`audio-events.json`) that the
visual-saliency pass ([`visual-saliency.md`](visual-saliency.md), VS-42) and the
angle selector (VS-43/46) can correlate against the picture.

It analyzes the **master audio** of a synced multicam group (the reference
recorder track), or any single source.

## 2. What to detect (tiered by value vs cost)

**Tier 1 — cheap, pure-DSP, ship first (high value):**
- **Loudness / energy envelope** — short-window RMS (and optionally an
  EBU-R128-style loudness), the backbone signal. Drives dynamics and gates the
  other detectors.
- **Onsets / accents** — positive energy/spectral flux peaks with a refractory
  gap. Beat-ish events to cut on; density distinguishes busy vs sustained passages.
- **Quiet / silence regions** — intro/outro/breaths/breaks (envelope below a
  floor) — useful negative space (don't cut frantically over a held note).
- **Instrumental-vs-vocal sectioning (coarse)** — combine energy + spectral shape
  (centroid / band-energy ratio) + the **whisper transcript already produced**:
  spans with words ≈ vocal; energetic spans without words ≈ instrumental
  (the guitar riff). This is the cheapest reliable "riff vs singing" signal.

**Tier 2 — moderate cost, pure-DSP + heuristics (good value):**
- **Spectral descriptors per window** — centroid, rolloff, flux, zero-crossing
  rate, a few band energies — a compact timbre fingerprint for "bright/plucky
  (guitar) vs mid (voice)" and for clustering.
- **Section/structure segmentation** — novelty/self-similarity over the spectral
  features to mark verse/chorus/solo boundaries (where a cut is musically natural).

**Tier 3 — needs a model or separation, defer / optional (highest cost):**
- **Which singer is active** (vocalist diarization, two singers in BYAM) — speaker
  diarization on the vocal track. Reliable only after source separation; without
  it, approximate from whisper segments + the **visual** active-speaker signal
  (VS-42) rather than audio alone.
- **Instrument identification / "is the guitar soloing"** — beyond "energetic +
  no words." Needs a tagging model or stems.
- **Beat/tempo grid** — a true beat tracker (vs bare onsets) if we want cuts
  locked to the downbeat.

## 3. Recommended approach (within the project's stack)

Stay inside the existing **ffmpeg + whisper + Ollama + pure-JS DSP** stack
(CLAUDE.md's "external-tool pipeline"); no new heavyweight runtime.

| Signal | How | Reuses |
|--------|-----|--------|
| mono PCM extract | `ffmpeg -ac 1 -ar 16000 -f f32le` | the `extractMono` pattern in `sync-multicam.mjs` |
| RMS / energy envelope, onsets, quiet | pure JS over the PCM frames | new pure module (see §5) |
| spectral features (centroid/flux/bands) | windowed FFT | **`fftInPlace` already in `tools/multicam-dsp.mjs`** |
| vocal vs instrumental | energy+spectral **gated by the whisper transcript** | whisper output already in the pipeline (R6.5 `transcripts/`) |
| section boundaries | spectral self-similarity novelty | new pure module |
| event descriptions | template strings from the typed fields; optionally one Ollama text pass to phrase them | `ollama.ts` (optional) |

**Feasibility — measured on the real BYAM master** (`node` probe, 50 ms RMS
frames, pure JS): 240.16 s analyzed in well under a second; **633 onsets**
(~158/min); **6.7%** quiet; and the **first-3 s guitar intro read at 0.14× the
track's overall RMS** — i.e. the energy envelope alone already separates the
instrumental intro from the full-band sections. So Tier 1 is cheap and works
today with zero new dependencies.

### Source separation (Demucs etc.) — recommendation: **defer (optional v2)**

Stems (vocals/guitar/drums/bass) would make vocalist diarization and "is the
guitar soloing" robust. But Demucs pulls in a Python+PyTorch runtime far outside
the current stack, is slow on CPU, and is a big install ask for a macOS toolkit.
**Recommendation:** ship Tiers 1–2 with no new deps; design the schema so a future
**optional** stem pass can populate `source`/`stem` fields and a per-stem energy
envelope without breaking consumers. Revisit if VS-43's evaluation shows the
heuristics aren't good enough.

> **Decision flagged for the maintainer:** if you're open to an optional
> heavyweight local dep (Demucs/PyTorch) for much better "who's singing" +
> instrument detection, say so and Tier 3 moves up. Default assumed here: stay in
> the current stack.

## 4. `audio-events.json` schema (proposed)

```jsonc
{
  "version": 1,
  "source": { "path": "…/BYAM-audio-clean.wav", "durationSeconds": 240.162, "sampleRate": 48000 },
  "envelope": {                      // coarse, for the selector + UI
    "hopSeconds": 0.05,
    "rmsDb": [ -42.1, -38.0, … ]      // one value per hop (downsampleable)
  },
  "events": [
    {
      "kind": "instrumental",        // see kinds below
      "startSeconds": 0.0,
      "endSeconds": 6.81,
      "confidence": 0.82,
      "description": "Quiet solo-guitar intro before the vocals enter.",
      "source": null,                // optional stem id once separation exists
      "data": { "meanRmsDb": -18.4, "onsetRate": 95 }   // kind-specific extras
    },
    { "kind": "onset", "startSeconds": 6.83, "endSeconds": 6.83, "confidence": 0.7, "description": "Strong accent." },
    { "kind": "vocal", "startSeconds": 6.81, "endSeconds": 41.0, "confidence": 0.9, "description": "Lead vocal section (lyrics present).", "data": { "wordCount": 73 } }
  ]
}
```

- **`kind`** (v1): `"envelope"`-derived `"quiet"`, `"onset"`, `"instrumental"`,
  `"vocal"`, `"section"` (boundary/label), `"accent"`/`"hit"`. Extensible; unknown
  kinds must be ignored by consumers.
- Every event has `startSeconds`/`endSeconds` (instant = equal), `confidence`
  (0–1), a human `description`, optional `source`/`stem`, and a `kind`-specific
  `data` bag.
- Times are in **seconds on the source/group clock** (consistent with
  `multicam.json`), so the selector can line them up with angle offsets directly.

## 5. Requirements

- **R-AE1** A pass analyzes a source (or a group's master audio) and emits
  `audio-events.json` per §4 (versioned; consumers ignore unknown `kind`s).
- **R-AE2** Tier-1 signals (energy envelope, onsets, quiet regions,
  vocal/instrumental sectioning gated by the whisper transcript) ship first, with
  **no new runtime dependencies** beyond the current stack.
- **R-AE3** All pure analysis (framing, RMS/flux, spectral features, segmentation,
  schema assembly, parse) lives in a unit-tested module held to **100%**
  lines/branches/functions (added to `vitest.config.ts` `coverage.include`); the
  ffmpeg extraction + any Ollama phrasing stay in a thin CLI documented in
  [`manual-test-plan.md`](manual-test-plan.md).
- **R-AE4** Times are seconds on the source/group clock; events are sorted by
  `startSeconds`.
- **R-AE5** The schema reserves optional `source`/`stem` fields so a future
  optional stem-separation pass can enrich events without breaking consumers
  (Tier 3 / Demucs is **deferred**).
- **R-AE6** Confidence + `data` are advisory; the angle selector (VS-43/46) decides
  how to weight them.

## 6. Out of scope (this doc)

Music transcription/notation, key/chord detection, lyric alignment beyond
whisper, real-time analysis, and the angle-selection logic itself (that's
[`multicam-auto-cut.md`](multicam-auto-cut.md), VS-43). Stem separation is
deferred (R-AE5).

## 7. Follow-ups

- **VS-44 — done.** Tier 1 implemented (R-AE1–R-AE6): envelope, onsets, quiet, and
  whisper-gated vocal/instrumental sectioning. Per-singer diarization, instrument
  ID, and `"section"`-novelty labels were **not** built (Tier 2/3).
- **VS-49 (new)** — Tier 2: spectral descriptors (centroid/flux/bands via the
  `fftInPlace` already in `multicam-dsp.mjs`) + section/structure novelty, to
  sharpen "riff vs sustained" and mark verse/chorus/solo boundaries.
- **VS-48** — optional stem separation (Demucs) populating `source`/`stem` +
  per-stem envelopes; only if the angle-selector evaluation justifies the
  dependency (maintainer decision).

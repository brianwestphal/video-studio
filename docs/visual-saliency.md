# Per-angle visual saliency (design / requirements)

Status: **Shipped (VS-45)** — design from VS-42. Implemented as
`tools/visual-saliency.mjs` (pure, 100% unit-tested) + `tools/analyze-visual-saliency.mjs`
(ffmpeg motion pass + gated Ollama vision → `saliency.json`). Feeds the
angle-selection model in [`multicam-auto-cut.md`](multicam-auto-cut.md) (VS-43 →
build VS-46). Cross-referenced from [`multicam.md`](multicam.md). Pairs with
[`audio-events.md`](audio-events.md) (VS-41/44).

## 1. Why

Auto multi-cam cutting needs to know **which angle is worth showing** at each
moment — the singer who's actually singing, the guitar during a riff, the angle
with motion/action — and to avoid sitting on a static angle of someone doing
nothing. The analyzer today describes **one representative frame per scene** of a
**single** video ([`analyzeFrame`](../src/ollama.ts) → a text description). This
doc specifies a per-angle, over-time **saliency score** so the selector (VS-43/46)
can rank angles window by window.

## 2. What to score, per angle per window

- **Performer activity** — is a person **actively singing / speaking into a mic**
  (mouth open, vocalizing). Deliberately **not** "playing an instrument" — that keeps
  an instrumentalist (head down over a guitar) from reading as the active singer, which
  matters because the selector uses `performer` to pick the singer during vocals (VS-64).
  Instrument playing is captured separately by the `instrument` score.
- **Instrument in frame & in use** — e.g. the guitar being strummed (pairs with
  the `instrumental` audio events from VS-41).
- **Motion / visual energy** — cheap frame-difference magnitude.
- **Framing / shot quality** — close-up vs wide, subject in focus, well-composed
  vs empty/cutaway.
- **Subject presence** — face/person count and prominence.

Output is a small set of **numeric scores (0–1) + labels + confidence** per
(angle, window), not prose — so the selector can compare angles arithmetically.

## 3. Recommended approach (within the project's stack)

Two-stage, **cheap signal gates the expensive model** — same ffmpeg + Ollama
stack, no new deps:

1. **Cheap, every angle, dense (ffmpeg/pure-JS):**
   - frame-difference **motion** per window (ffmpeg `select='gt(scene,…)'` /
     `signalstats`, or decode small thumbnails and diff in JS);
   - reuse the existing **scene-cut** detection (`SCENE_THRESHOLD`) to find shot
     changes;
   - this alone gives a motion/energy score and decides **where** to spend vision.
2. **Vision model, sampled (Ollama `analyzeFrame`, extended prompt):** at window
   centers (gated by stage 1 + the audio-events section boundaries from VS-41,
   not blindly every N seconds), send the angle's frame with a **structured
   prompt** asking for the fields in §2 and request a compact JSON-ish reply;
   parse to scores. Sampling at section/shot boundaries instead of a fixed grid is
   what keeps the cost bounded.

**Cadence & cost.** A naive fixed grid (every ~2 s × 4 angles over ~240 s) is
~480 vision calls — minutes on local Ollama. Gating to shot-changes + audio
sections cuts that by a large factor and concentrates calls where the picture
actually changes. Make the cadence/cap a CLI knob and **`log()` what was skipped**
(no silent truncation, per CLAUDE.md). Motion-only (no vision) is a valid cheap
mode for a first cut.

> **Decision flagged for the maintainer:** acceptable vision budget? Options:
> (a) motion-only, no model (fast, crude); (b) vision at shot/section boundaries
> (recommended balance); (c) dense vision grid (slow, most accurate). Default
> assumed: (b).

## 4. Saliency schema (proposed)

Per group, per angle, a series of windows on the **group clock** (so it lines up
with `multicam.json` offsets and `audio-events.json`):

```jsonc
{
  "version": 1,
  "groupId": "byam",
  "windowSeconds": 2.0,
  "angles": {
    "byam-cam-1": [
      {
        "startSeconds": 6.0, "endSeconds": 8.0,
        "scores": { "performer": 0.9, "instrument": 0.3, "motion": 0.4, "framing": 0.8, "presence": 1.0 },
        "labels": ["singing", "medium-shot", "two-people"],
        "saliency": 0.82,           // combined score the selector can use directly
        "confidence": 0.7,
        "shotType": "medium",       // coarse shot size wide|medium|close|null (VS-66)
        "source": "vision"          // or "motion" when the model was gated out
      }
    ],
    "byam-cam-4": [ … ]
  }
}
```

- `shotType` is a coarse shot size (`wide`/`medium`/`close`, else null) the vision
  model reports, used by the selector's shot-type variety penalty (VS-66); `shotTypeOf`
  falls back to a `labels` hint when it's absent.
- `scores` are independent 0–1 dimensions; `saliency` is a combined convenience
  score (weights documented + tunable); `labels` are free-text tags from the model;
  `source` records whether the window was model-scored or motion-only.
- Windows align across angles (same `windowSeconds` grid) so the selector compares
  like-for-like.

## 5. Requirements

- **R-VS1** A pass scores each synced video angle over aligned windows on the
  group clock and emits the §4 schema (versioned; unknown fields ignored).
- **R-VS2** A cheap motion/scene-cut stage runs for every angle and **gates** the
  vision-model calls; vision cadence + a per-run cap are CLI knobs, and skipped
  windows are logged (no silent truncation).
- **R-VS3** Pure logic (windowing, motion scoring, vision-reply parsing, score
  combination, schema assembly) is unit-tested to **100%** (added to
  `vitest.config.ts`); frame sampling + Ollama calls stay in the I/O layer, in the
  [`manual-test-plan.md`](manual-test-plan.md).
- **R-VS4** Persisting into the analyzer output must bump/handle
  `STATE_VERSION` in [`analyzer-state.ts`](../src/analyzer-state.ts) so older
  state isn't silently misread.
- **R-VS5** Scores/labels/confidence are advisory; the selector (VS-43/46) owns
  the final weighting.

## 6. Out of scope

Face **recognition**/identity (we only need "a person, performing" + position),
pose estimation, re-identifying the same singer across angles by appearance
(the audio + position cues handle "who's singing"), and the selection logic
itself (VS-43).

## 7. Implementation (shipped, VS-45)

```
node tools/analyze-visual-saliency.mjs <multicam.json> [--group id] [--window sec] \
  [--audio-events path] [--mode motion|vision|grid] [--cap n] [--motion-scale n] \
  [--model name] [--total sec] [--out path]
```

- **`tools/visual-saliency.mjs`** (pure, 100% coverage in
  `tests/visual-saliency.test.ts`): `buildWindows` (aligned group-clock grid),
  `sourceTime`/`angleCoversWindow` (group→media mapping, mirrors `resolveAngleCuts`),
  `normalizeMotion`, `parseVisionReply` (robust JSON-ish parse), `combineSaliency` +
  `DEFAULT_WEIGHTS`, `selectVisionWindows` (the gating, R-VS2), `sectionBoundaries`
  (audio-events → boundary times), `assembleWindowScore`, `buildSaliency` (the §4
  schema, `SALIENCY_VERSION`), and `visionPrompt`.
- **`tools/analyze-visual-saliency.mjs`** (I/O, manual-test-plan §11): one cheap
  ffmpeg pass per angle (`scale=64:36,fps=2,tblend=difference,signalstats` → the
  difference frame's average luma = motion magnitude, decoded only as far as the
  group clock needs), which scores every covered window and **gates** the Ollama
  vision calls; selected windows extract a frame and ask the model for the §2
  fields. Writes `saliency.json`.
- **Cadence/cost:** `--mode vision` (default) runs the model only at section
  boundaries / high-motion windows, `--cap` bounds the calls per angle, and the run
  logs the vision-vs-motion-only split (no silent truncation). `--mode motion` skips
  the model entirely; `--mode grid` scores every covered window.
- **No analyzer-state bump (R-VS4):** saliency is a **separate per-group artifact**
  (`saliency.json`, like `audio-events.json`), not stored in the analyzer's
  per-video `state.json`, so `STATE_VERSION` is untouched. The doc itself is
  versioned (`SALIENCY_VERSION`).

## 8. Follow-ups

- Revisit cadence/weights after VS-46's evaluation on the BYAM angles (the
  selector consumes this and owns the final weighting, R-VS5).
- A frame-difference motion metric is coarse; an optional flow/feature signal could
  sharpen it later if the selector needs it.
- **`performer` = active singer, not instrumentalist (VS-64, shipped).** The prompt was
  refined + validated against real BYAM frames on the live model: a head-down guitarist
  and a hands-on-guitar close-up dropped from `perf ~0.9` to `~0.2`, while frames of
  someone actually singing stayed high (`~0.8–0.9`). Realized on the next saliency run.

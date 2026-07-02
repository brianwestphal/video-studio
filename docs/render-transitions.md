# Rendering transitions into the video (no FCP)

Status: **Shipped** — Tier-A windowed-and-full-chain renderer (VS-54); **windowed
re-encode optimization + native Tier-B/C transitions (VS-55)**. This is the
source-of-truth requirements doc for `tools/render-transitions.mjs` and its pure
core `tools/transitions-render.mjs`. It extends the FCP transition-suggestion
feature ([`transitions.md`](transitions.md)) with an *additional* output: a
finished `.mp4`/`.mov` that has the transitions **baked in**, for users who never
open Final Cut Pro.

> **Early concept.** Pre-1.0 feature; details may change.

## 1. Purpose

The shipped `transitions` block on a cut spec emits FCP `<transition>` elements
into the editor-handoff `.fcpxml` ([`transitions.md`](transitions.md)) — but those
only render when the user opens the timeline in FCP. `render-transitions` bakes the
same transitions into the toolkit's own rendered video via ffmpeg, with **no FCP
required**. It reuses the export's baked segment **handles** (the media overlap a
dissolve needs) exactly as the FCPXML path does — see [`transitions.md`](transitions.md)
§2 (R-TR1).

```
node tools/render-transitions.mjs <export>/manifest.json [--out <file.mov>] [--full-chain]
```

## 2. Render strategies

There are two strategies that produce the same visible cut.

- **R-RT1 — Windowed re-encode (default).** Because the exported segments are
  **all-intra ProRes**, the renderer re-encodes **only the short overlap at each
  transition** and stream-copies the rest. It splits each segment into a `body`
  span (the part not consumed by an adjacent transition) and, at each transitioned
  cut, a `clip` (the centered overlap). Bodies are concatenated straight from the
  source via the concat demuxer's frame-exact `inpoint`/`outpoint` (the same
  mechanism `rebuild.sh` uses); only the `clip`s are decoded/filtered/encoded. So
  the render **cost ≈ Σ(transition duration)**, independent of the cut's length or
  how many plain hard cuts it has.
- **R-RT2 — Full chain (`--full-chain`).** The original single
  `xfade`/`acrossfade` filtergraph over the whole timeline — re-encodes every
  frame. Kept for comparison and as a fallback; it is sample-exact in container
  duration (see R-RT6).

## 3. Transition tiers (native recipes)

Each shipped FCP transition maps to an ffmpeg recipe in one of three tiers. The
windowed renderer reproduces all three natively (each transition `clip` is its own
filtergraph). The full-chain renderer can only chain single `xfade` filters, so it
degrades Tier B/C to the nearest Tier-A look.

- **R-RT3 — Tier A (direct `xfade`).** Cross Dissolve → `dissolve`, Fade To Color
  → `fadeblack`, Slide → `coverleft`, Push → `slideleft`, Wipe → `wipeleft`,
  Diagonal → `diagtl`, Clock → `radial`, Circle → `circleopen`, Center →
  `circlecrop`.
- **R-RT4 — Tier B (`xfade=custom` expression).** Chevron → a sideways-V wipe
  whose reveal edge leads at the vertical centre (`CHEVRON_EXPR`); Static → a
  noise-modulated dissolve where each pixel flips at a stable pseudo-random
  threshold (`STATIC_EXPR`).
- **R-RT5 — Tier C (overlay + animated mask / crop-and-slide).** Circle Inset → the
  incoming clip revealed through a growing circular alpha mask (`geq`+`overlay`);
  Rectangle Inset → a growing rectangular mask; **Shapes Inset → a growing diamond
  (L1-distance) mask, distinct from the circle (VS-57)**; Side-by-Side Split → the
  outgoing clip's two vertical halves slide apart (`crop`+`overlay`) to reveal the
  incoming; Top & Bottom Split → the same horizontally. The inset masks have a
  **feathered edge** (a soft alpha ramp of ~`FEATHER` of the shape's reach, VS-57)
  rather than a hard step, matching FCP's soft inset edges.

The name→recipe map (`TRANSITION_RECIPES`) and per-clip filtergraph assembly
(`windowedClipFilter`) are pure and 100% unit-tested; the ffmpeg renders are
manual/pipeline (see [`manual-test-plan.md`](manual-test-plan.md) §10).

## 4. Correctness & edge handling

- **R-RT6 — Visible timeline preserved.** Both strategies keep the full visible
  cut — the handles absorb the transitions, so no visible content is shortened and
  the output length matches the visible timeline to within ~1 frame at each cut
  boundary (the same xfade/concat rounding the full-chain renderer has always had).
  Because the windowed renderer stream-copies ProRes, its **container duration**
  metadata may read marginally long (a sub-frame hold at each join — a known ProRes
  copy artifact); `--full-chain` re-encodes the whole timeline and is the
  sample-exact option if that matters.
- **R-RT7 — Handle clamping.** Each transition duration is clamped to ≤ 2×(the
  available handle on each side). A cut whose flanking segments have no usable
  handle material **degrades to a clean hard cut** (no clip; the bodies abut) — no
  error, no dropped frames. A short body fully consumed by its two transitions
  clamps to zero duration (skipped in the concat).
- **R-RT8 — Audio.** In the single-source case the segment audio is crossfaded
  (`acrossfade`) over each transition and stream-copied elsewhere. In the multi-cam
  case the manifest's continuous **master `audioTrack`** is muxed under the
  transitioned video unchanged (no crossfade). Video-only source segments are
  handled (the renderer probes for an audio stream).
- **R-RT9 — Opt-in / no-op.** A manifest with no `transitions` is an error with a
  pointer to `rebuild.sh` for a plain cut. The FCPXML transition-suggestion path
  ([`transitions.md`](transitions.md)) is unaffected by this feature.

## 5. Implementation

- **`tools/transitions-render.mjs`** (pure, 100% coverage in
  `tests/transitions-render.test.ts`):
  - `TRANSITION_FFMPEG` / `xfadeId` — the Tier-A `xfade` id map (full-chain path).
  - `TRANSITION_RECIPES` / `transitionRecipe` + `CHEVRON_EXPR` / `STATIC_EXPR` —
    the native tier classification + recipes (R-RT3–R-RT5).
  - `buildTransitionRenderPlan` / `transitionFilterComplex` — the full-chain plan
    + filtergraph (R-RT2).
  - `buildWindowedRenderPlan` — the body/clip span arithmetic (R-RT1, R-RT6,
    R-RT7).
  - `windowedClipFilter` — the per-clip filtergraph for a single transition (Tier
    A `xfade`, Tier B `xfade=custom`, Tier C overlay/mask/crop-slide).
- **`tools/render-transitions.mjs`** (thin I/O, manual-tested): the ffmpeg runs —
  renders each transition clip, writes the concat list (segment bodies via
  `inpoint`/`outpoint` + the clips), concat-copies, and muxes the master audio in
  the multi-cam case.

## 6. Follow-ups

- Wired into the skill as the "finish without FCP" path in `skills/video-studio/SKILL.md`
  Step 7, alongside `rebuild.sh` (plain cut) and the `.fcpxml` (FCP import). *(VS-56, done.)*
- Tier-C inset fidelity: **feathered mask edges + a distinct `Shapes Inset` diamond
  shipped (VS-57)**; an optional border and offset/scaled (shrunken) insets, plus
  additional `xfade=custom` looks, remain open if closer FCP parity is wanted.
- Wall-clock: on a synthetic 24 s / 720p cut with two 0.5 s transitions the
  windowed renderer was ~4× faster than `--full-chain` (~0.9 s vs ~3.4 s) and used
  ~6× less CPU — it re-encodes ~1 s of overlap vs the full 24 s. The advantage
  grows with cut length and shrinks as transitions cover more of the runtime
  (manual-test-plan §10.5).

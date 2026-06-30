# FCP Transition Suggestions

Status: **Shipped (VS-28, palette expanded VS-50; ffmpeg render VS-54)** — opt-in
`transitions` on the cut spec emit FCP `<transition>` elements into the
editor-handoff `.fcpxml`, with handle media baked into the flanking segments
(VS-23/VS-28/VS-50; extends the FCPXML export, [`editor-handoff.md`](editor-handoff.md)
§6, VS-25). The effect `uid`s + transition geometry were captured from a real FCP
"Export XML" and the output validates against FCP's bundled `FCPXMLv1_10.dtd`.
**`render-transitions` (VS-54)** additionally bakes the transitions into a finished
video with **no FCP required**, via ffmpeg `xfade`/`acrossfade` over the same baked
handles (Tier A palette; see §8).

**Supported transitions** (`TRANSITION_UIDS` in `tools/fcpxml.mjs`): Cross
Dissolve, Fade To Color ("Dip to Color" alias); Slide, Push; Wipe, Diagonal,
Clock, Circle, Chevron, Center; Circle/Rectangle/Shapes Inset, Side-by-Side Split,
Top & Bottom Split; Static. Audio Crossfade rides every video transition. The
`FxPlug:<GUID>` uids are stable per FCP version; the motion-template (`.motr`)
ones use FCP's literal `.../` path prefix and may be less install-portable.

> **Early concept.** Pre-1.0 feature; details may change.

## 1. Purpose

When exporting a cut to Final Cut Pro, also **suggest transitions** at the cut
points so the user starts from a styled timeline rather than a string of hard
cuts. Per the maintainer's decisions:

- **Surfaced by inserting** FCP `<transition>` elements directly into the
  exported `.fcpxml`, on the timeline at the relevant cuts — ready to tweak or
  delete in FCP. (Not a separate sidecar file.)
- **AI-chosen per cut** — Claude picks each transition from the scene
  descriptions, pacing, the **type of video being made** (teaser / social / long
  edit), and other cues from the prompt and sources.
- **Any built-in FCP transition** is fair game; selection is **tuned by stylistic
  guidance** (below), not a single fixed default.

## 2. Hard requirement: segment handles

**FCP transitions need media overlap.** A dissolve between clip A and clip B
consumes extra frames *past* A's out-point and *before* B's in-point — the
"handles." video-studio's export currently cuts segments to exact in/out
(the [editor-handoff](editor-handoff.md) §8 open question), so a transition has
no material to dissolve through.

- **R-TR1** When transitions are requested, the export must give each segment
  **handles** (extra media beyond the cut on both sides — default ~12–24 frames,
  configurable). The manifest records each segment's handle length so `rebuild.sh`
  and the FCPXML place clips/transitions correctly. This makes the editor-handoff
  "handles" item a requirement for this feature (a prerequisite change to the
  segment export).

## 3. Inserting transitions into the FCPXML

- **R-TR2** For each chosen cut, emit a `<transition>` on the spine spanning the
  cut, referencing a built-in transition effect (an `<effect>` resource with the
  FCP built-in `uid`, e.g. Cross Dissolve), with frame-aligned rational `offset`
  (cut point − half duration) and `duration`.
- **R-TR3** The flanking clips must overlap by the transition duration (uses the
  handles from R-TR1); offsets/durations recomputed so the timeline length and
  segment target ranges still reconcile with the manifest.
- **R-TR4** A "hard cut" suggestion emits **no** transition element (the default
  butt-cut), so the AI can choose to leave cuts plain.
- **R-TR5** Transitions are **opt-in** (e.g. an export flag / a `transitions`
  block in the cut spec); without it the export is unchanged (VS-24/25 behavior).

## 4. AI selection + stylistic heuristics

Claude assigns a transition (or hard cut) per cut from the built-in palette,
informed by the cut's context and these starting heuristics (to be refined by
researching editorial guidance and tuned per video type):

- **Hard cut (no transition)** — the default for energy, continuity, on-beat
  cuts, and dialogue/soundbite joins. Teasers and social cuts lean hard-cut.
- **Cross Dissolve** — a passage of time, a mood/topic shift, or smoothing a
  montage of B-roll; short (~10–20 frames) for subtlety. The long-edit archetype
  uses these more.
- **Dip to Color / Fade to Color (black)** — a chapter or scene break, intro/
  outro, or a hard tonal reset; longer (~0.5–1s).
- **Blur / light dissolves, wipes, etc.** — sparing, stylistic accents matched to
  an energetic or playful video; avoid in restrained/corporate edits.

Tuning inputs: the **video type** (teaser → mostly hard cuts + occasional quick
dissolve; social 9:16 → punchy; long edit → smoother dissolves/dips), the
scene **descriptions** (mood shift vs continuous action), **pacing** (segment
durations / beat), B-roll vs soundbite, and explicit **prompt cues** ("keep it
snappy", "documentary feel"). Selection should explain its reasoning so the user
can audit it.

## 5. Likely implementation (non-binding)

- Add handle support to the segment export (`export-manifest.mjs` /
  `export-project.mjs`) gated on a transitions request — prerequisite (R-TR1).
- Extend `tools/fcpxml.mjs` to emit `<effect>` resources + `<transition>`
  elements from a `transitions` list on the cut spec (each: at-cut index, FCP
  transition name, duration). Pure → unit-testable, like the rest of fcpxml.mjs.
- The **skill** decides the transitions (per §4) and writes them into the cut
  spec; SKILL.md gains transition guidance + the video-type heuristics.

## 6. Implementation (shipped, VS-28)

- **Handles (R-TR1):** `buildManifest` (in `tools/export-manifest.mjs`) records each
  segment's `handleStartSeconds`/`handleEndSeconds`/`fileDurationSeconds` when
  `spec.transitions` is present; `segmentArgs` bakes the handles into the exported
  ProRes (clamped to the source, head + tail), and `rebuildScript` trims them back
  via the concat demuxer's `inpoint`/`outpoint` (frame-exact on all-intra ProRes).
  Handle length = `max(spec.handleSeconds ?? 0.5, longest transition / 2)`.
  Drift-retimed clips skip handles.
- **FCPXML (R-TR2–R-TR5):** `buildFcpxml` (in `tools/fcpxml.mjs`) emits `<effect>`
  resources + spine `<transition>`s (centered on the cut: `offset = cut − dur/2`)
  with a `<filter-video>` to the effect + a `<filter-audio>` Audio Crossfade. Clips
  stay contiguous and reference the handle-inclusive asset (clip `start` = head
  handle). Hard cuts emit nothing (R-TR4); opt-in via `spec.transitions` (R-TR5).
- **Effect uids** (`TRANSITION_UIDS` in `fcpxml.mjs`, captured from a real FCP
  export): Cross Dissolve `FxPlug:4731E73A-…`, Fade To Color `FxPlug:F779C565-…`,
  Audio Crossfade `FFAudioTransition`. "Dip to Color" is an accepted alias.
- **Skill:** SKILL.md Step 7 has the per-cut selection guidance (§4), and each
  entry carries a `reason` for transparency.

## 7. Open questions / follow-ups

- ~~**More built-in transitions.**~~ **Done (VS-50):** the full palette from the
  FCP sample is wired (16 transitions across dissolves/fades, movements, wipes,
  insets/splits, and Static), with the SKILL.md §4 guidance grouped by feel.
- **Per-video-type default durations** are guidance in SKILL.md, not enforced.
- **Deeper editorial research** to refine §4 heuristics (a `deep-research` pass)
  remains optional.

## 8. Rendering transitions without Final Cut Pro (investigation, VS-52)

**Question:** the shipped transitions are *FCPXML suggestions* — they only render
when the user opens the timeline in FCP. Can the toolkit bake real transitions
into its own finished `.mp4`/`.mov` output (the teaser / social / long cuts) so
users who never touch FCP still get them?

**Answer: yes, and the groundwork is already laid.** Verified against ffmpeg 8.1.

### What ffmpeg gives us
- **`xfade`** (video) — a two-input cross-fade filter with **58 transition types**
  (`fade`, `dissolve`, `wipeleft/right/up/down`, `slide*`, `smooth*`,
  `circleopen/close`, `circlecrop`, `rectcrop`, `radial`, `fadeblack/white`,
  `pixelize`, `diag*`, `*slice`, `squeeze*`, `hblur`, `fadegrays`, …) plus a
  `custom` expression mode. Parameters: `transition`, `duration`, and `offset`
  (when the wipe starts on the first input).
- **`acrossfade`** (audio) — the matching audio cross-fade, so a video transition
  carries an audio blend just like the FCP path's Audio Crossfade.

**Cross fade is *not* the only type we can do.** Mapping the full shipped palette
(`TRANSITION_UIDS`, VS-50) to ffmpeg, in three tiers of effort:

| FCP transition | ffmpeg | Tier |
|---|---|---|
| Cross Dissolve | `xfade=dissolve` (or `fade`) | **A — direct xfade** |
| Fade To Color (black/white) | `xfade=fadeblack` / `fadewhite` | **A** |
| Slide | `xfade=coverleft/right/up/down` or `reveal*` (one image moves) | **A** |
| Push | `xfade=slideleft/right/up/down` (both images move) | **A** |
| Wipe | `xfade=wipeleft/right/up/down` | **A** |
| Diagonal | `xfade=diagtl/tr/bl/br` | **A** |
| Clock | `xfade=radial` | **A** |
| Circle | `xfade=circleopen` / `circleclose` | **A** |
| Center | `xfade=circlecrop` / `rectcrop` / `squeezeh`/`v` | **A** (closest) |
| Fade To Color (arbitrary color) | `fade=out:color=…` + `fade=in` over a color bg | **B — custom** |
| Chevron | `xfade=custom` expr (triangle/chevron mask) or degrade to a wipe | **B** |
| Static | noise-modulated dissolve (`xfade=pixelize`, or `custom` geq-noise) | **B** |
| Circle / Rectangle / Shapes **Inset** | `overlay` + an animated shape **alpha mask** (`geq`/`maskedmerge`) | **C — compositing** |
| Side-by-Side **Split** / Top & Bottom **Split** | `crop` halves + slide them apart over the incoming (`overlay` x/y expr) | **C** |

So **~9 of the 16 are direct `xfade`** (Tier A), **3 more are a `custom`
`xfade` expression** (Tier B), and only the **5 modular Inset/Split** transitions
need a small **overlay/mask filtergraph** (Tier C) — heavier, but none are
impossible. ffmpeg 8.1 exposes 58 `xfade` types total, so Tier A is comfortably
the common case (dissolves, fades, wipes, slides/pushes, clock, circle).

### Why it fits the existing pipeline
1. **The hard prerequisite — media overlap (handles) — is already produced.** §2's
   handles: when `transitions` are requested, `buildManifest` bakes
   `handleStartSeconds`/`handleEndSeconds` of extra source past each cut into every
   segment (`tools/export-manifest.mjs`). `xfade` consumes exactly that overlap.
   Today `rebuild.sh` *trims* the handles and hard-concats; a render mode would
   instead **keep** them and `xfade`-chain consecutive segments over the handle
   region.
2. **Segments are already conformed** to one size/fps/pixel-format (ProRes at the
   project fps), satisfying `xfade`'s "both inputs identical format" requirement.
3. **The export already re-encodes** (overlay compositing), so the extra
   decode+filter+encode `xfade` needs is not a new cost class.

### Sketch
A pure `TRANSITION_FFMPEG` map (name → `xfade` transition id), parallel to
`TRANSITION_UIDS`, plus pure **offset math** (each `xfade`'s `offset` =
cumulative timeline position of the cut, `duration` = the transition length ≤
2×handle). The rebuild composes a filtergraph chaining `xfade`+`acrossfade` across
the cut list; segments without a transition stay hard cuts (a zero-duration / plain
concat join). All of that — the map and the offset/duration arithmetic — is
**pure and 100% unit-testable**; only the ffmpeg run itself is manual/pipeline.

### Performance — only re-encode the transition windows
The maintainer's instinct is right: naively `xfade`-chaining the *whole* timeline
re-encodes every frame, and the Tier-C compositing transitions (per-frame mask
generation) are genuinely slower. The fix makes cost independent of clip length:
**only re-encode the short overlap at each cut, then stream-copy-concat the rest.**
Exported segments are **all-intra ProRes**, so they can be cut and joined on any
frame without a re-encode. So the render is:

1. For each cut with a transition, render just the **~0.5–1 s overlap** (the baked
   handle region) through `xfade` / the compositing filtergraph → a short
   transition clip.
2. Emit the **between-transition body** of each segment as a stream-copy span.
3. `concat` the bodies + transition clips in order.

Cost ≈ Σ(transition duration) — a handful of sub-second renders — **not** the full
runtime, regardless of how long the cut is or how many plain hard-cuts it has. The
heavier Tier-C transitions then only pay over their own short windows. (Audio is
the mirror: `acrossfade` the overlap, copy the rest.) Encode settings, thread
count, and `xfade` vs compositing choice are second-order next to this.

### Shipped — `render-transitions` (VS-54, Tier A)

```
node tools/render-transitions.mjs <export>/manifest.json [--out <file.mov>]
```

Reads an editor-handoff export (its `segments` carry the baked handles + the
`transitions` list) and renders one finished video, dissolving/wiping/sliding
through each cut. The FCPXML suggestion path is untouched — this is an additional
output for users who never open FCP.

- **`tools/transitions-render.mjs`** (pure, 100%): `TRANSITION_FFMPEG` (name →
  `xfade` id), `xfadeId`, `buildTransitionRenderPlan` (per-segment trims + per-join
  arithmetic: each `xfade` `offset` = running output length − duration; duration
  **clamped to ≤ 2×available handle**; a cut with no handle material degrades to a
  hard `concat`), and `transitionFilterComplex` (the `xfade`/`acrossfade` graph).
- **`tools/render-transitions.mjs`** (thin I/O): trims each segment to its piece,
  runs the one filtergraph, and muxes the continuous master audio afterward in the
  multicam case. Validated on a synthetic 3-clip cut (manual-test-plan §10): the
  output length equals the visible timeline (handles absorb the dissolves) and a
  mid-dissolve frame is a genuine A→B blend.
- **Tier mapping:** Tier A transitions use their direct `xfade` id; Tier B/C
  (chevron/static/inset/split) currently fall back to the nearest Tier-A look.

**Deferred (VS-55):** the **windowed re-encode** above (only re-encode the overlap,
stream-copy the rest) — the current renderer re-encodes the whole timeline, which
is correct but not yet optimized — plus native Tier-B/C transitions
(custom-expression / overlay-mask filtergraphs).

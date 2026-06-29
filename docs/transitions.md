# FCP Transition Suggestions

Status: **Shipped (VS-28)** — opt-in `transitions` on the cut spec emit FCP
`<transition>` elements (Cross Dissolve + Fade To Color) into the editor-handoff
`.fcpxml`, with handle media baked into the flanking segments. Covers VS-23/VS-28;
extends the FCPXML export ([`editor-handoff.md`](editor-handoff.md) §6, VS-25).
The effect `uid`s + transition geometry were captured from a real FCP "Export XML"
(VS-28) and the output validates against FCP's bundled `FCPXMLv1_10.dtd`.

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

- **More built-in transitions.** Only Cross Dissolve + Fade To Color are wired.
  The FCP sample export (VS-28 attachment) also contains uids for Static, Circle
  Inset, Push, Slide, etc. — adding them is a mechanical extension of
  `TRANSITION_UIDS` (filed as a follow-up).
- **Per-video-type default durations** are guidance in SKILL.md, not enforced.
- **Deeper editorial research** to refine §4 heuristics (a `deep-research` pass)
  remains optional.

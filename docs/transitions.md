# FCP Transition Suggestions

Status: **Design only** (not yet implemented). Covers VS-23. Extends the FCPXML
export ([`editor-handoff.md`](editor-handoff.md) §6, shipped in VS-25).

> **Early concept.** Design intent for a pre-1.0 feature; details may change.

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

## 6. Open questions / follow-ups

- The exact FCPXML `<effect>` `uid`s for the built-in transitions, and which
  subset to support first (Cross Dissolve + Dip to Color are the safe core).
- Default handle length + transition durations per video type.
- Should a hard-cut-only export still record "no transition" decisions (with
  reasons) for transparency, or stay silent?
- Deeper research into editorial transition conventions to refine §4 (the
  maintainer asked for stylistic guidance — a `deep-research` pass could sharpen
  the heuristics before/alongside implementation).

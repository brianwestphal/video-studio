# Desktop app — single-source cutting flow (VS-99)

The desktop app's Design → Review → Export was originally **multi-cam only**: the cut is a
`switches.json` (angle switching over `multicam.json`). A **single video** got through Import
(→ `sources.json`) + Analyze (→ `audio-events.json`) and then dead-ended — no `multicam.json`,
so neither Design lane nor Review/Export could proceed.

Single-source cutting is a **different model**: pick scene ranges → a **cut spec** →
`export-project` (segments + overlays + FCPXML) or a flat ffmpeg render, not angle switches.
This doc covers that path. It reuses the shipped editor-handoff cut-spec shape
([`editor-handoff.md`](editor-handoff.md)) so a single video reaches a finished MP4.

Part of the desktop-app initiative — see [`desktop-app.md`](desktop-app.md),
[`desktop-app-import.md`](desktop-app-import.md),
[`desktop-app-design.md`](desktop-app-design.md), and
[`desktop-app-export.md`](desktop-app-export.md).

Status: **Partial** — the **core flow works end-to-end** (Import → Analyze → Design → Export →
a finished `cut.mp4`) with audio-aware scene selection. Remaining: a single-source **Review UI**
(trim/reorder/drop clips before export) and prompt-tailored selection (the AI Auto lane, VS-96).
Depends on VS-90 (shell + project model) and VS-81 (import writing `sources.json`).

## 1. Design — propose a cut spec from the scene analysis

- **R-SS1** The single-source Design lane turns the scene analysis (`sources.json`) + a **cut
  kind** into a **cut spec** — `{ project: { fps, width, height, name }, clips: [ { source, in,
  out, audio } ] }`, the same shape `export-project` consumes ([`editor-handoff.md`](editor-handoff.md)).
  Named kinds carry a rough target length (`CUT_TARGETS`: *teaser* 15s, *sizzle* 20s,
  *soundbites* 40s, *highlights* 45s, *summary* 60s, *trailer* 75s); an explicit `targetSeconds`
  overrides it and `full` keeps every scene whole, in order. This is the pure `proposeCutSpec`
  (`desktop/sidecar/cutspec.mjs`, unit-tested); it throws when there are no analyzed scenes to
  cut from.

- **R-SS2** **Audio-aware selection.** When `audio-events.json` is present, scenes are **ranked
  by audio** rather than evenly spread: most kinds favor **loudness + onset density** (punchy
  moments), *soundbites* favors **vocal-section overlap** (the talking). Each clip is capped
  (`maxClipSeconds`, default 4s) so one long scene can't swallow the cut, and the chosen ranges
  are **restored to chronological order**. Without audio analysis it falls back to an even
  **spread** across the whole video. Robust to a missing/short envelope and zero-length scenes; a
  degenerate result (e.g. one very short scene) falls back to the first scene up to the target.
  Pure (`selectByAudio` / `selectSpread` in `cutspec.mjs`), unit-tested. This is the
  **deterministic baseline** auto-cut; tailoring it precisely to a prompt is the AI Auto lane
  ([`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md), VS-96).

- **R-SS3** The Design **host step** (`design-cut`) branches on the project shape: **multi-cam**
  → `propose-switches` (R-DS2); **single-source** → `proposeCutSpec` writes `cut.json` (no child
  process — the proposer is pure). The Auto-lane prompt selects the cut **kind/style**. *(host
  I/O; manual-test-plan §15.17.)*

## 2. The cut spec advances the rail (no separate angle review)

- **R-SS4** A single-source **`cut.json` satisfies both the Design and Review stages** — a
  single-video cut needs no separate angle-review pass — so the project reaches **Export**
  without a multi-cam `switches.json`. Encoded in the pure stage-state derivation
  (`deriveStages` in `desktop/sidecar/project.mjs`, R-APP7: `design`/`review` `doneWhen` accept
  `cut`), unit-tested.

## 3. Export — flat render or editor handoff

- **R-SS5** Single-source **Export** flat-renders the cut spec into a finished video:
  `flatRenderCommand` builds the ffmpeg **trim + concat** argv over the one source (per-clip
  `trim`/`atrim` → `concat`), encoding **H.264 / AAC**. With a target frame it **scales + pads to
  9:16** (e.g. 1080×1920, `force_original_aspect_ratio=decrease` + centered black pad). Pure
  (`cutspec.mjs`), unit-tested; the host runs ffmpeg with it. Throws on an empty cut.

- **R-SS6** The Export **host branch** routes single-source projects (a `cut.json`, no
  `multicam.json`) to the flat render (MP4 / 9:16) or to **`export-project`** over `cut.json` for
  the **FCPXML** editor handoff — not the multi-cam renderer. *(host I/O; manual-test-plan
  §15.17.)*

## 4. Editing the cut (single-source Review)

- **R-SS7** *(partial)* Before export, the cut is **editable**: clips can be **trimmed**
  (adjust in/out), **reordered**, or **dropped**. These are pure, immutable transforms over
  `cut.json` (`desktop/sidecar/cut-edit.mjs`: `trimClip` / `reorderClip` / `dropClip` /
  `cutDuration` — each returns a new cut and no-ops when the operation doesn't apply),
  unit-tested. The **Review UI surface** that calls them is the remaining tail (VS-102);
  today Review shows an honest "head to Export" message for single-source.

## 5. Follow-ups

- The single-source **Review UI** (the surface wiring the R-SS7 transforms to a timeline /
  clip list) — GUI, a UX pass (VS-102).
- **Prompt-tailored selection** — the AI Auto lane tailoring the cut to the prompt (rather than
  the deterministic audio-scored baseline) is **VS-96**.

## 6. Cross-references

- [`editor-handoff.md`](editor-handoff.md) — the cut-spec shape + `export-project` (segments /
  overlays / FCPXML) this flow feeds.
- [`multiple-sources.md`](multiple-sources.md) — `analyze-sources` → `sources.json` (the scene
  analysis Design reads).
- [`audio-events.md`](audio-events.md) — `audio-events.json` (loudness / onsets / vocal sections)
  that drives R-SS2 selection.
- [`multicam-auto-cut.md`](multicam-auto-cut.md) — the multi-cam counterpart (`propose-switches`).
- [`desktop-app-export.md`](desktop-app-export.md) — the Export lane the render feeds.

# Requirements Summary (AI summary)

Synthesized status view of [`../requirements.md`](../requirements.md). Status
markers: **Shipped** (built + works), **Partial** (built, gaps noted), **Design
only** (described, not built), **Deferred** (intentionally postponed). Keep in
sync with the requirements doc and code; the source wins on conflict.

## Dashboard

| Area | Requirements | Status |
|------|-------------|--------|
| Platform & deps | R2.1–R2.5 | **Shipped** |
| Launcher | R3.1–R3.7 | **Shipped** |
| Scene analyzer | R4.1–R4.8 | **Shipped** |
| Overlay generator | R5.1–R5.5 | **Shipped** |
| The skill | R6.1–R6.5 | **Shipped** |
| Quality gates | R7.1–R7.4 | **Shipped** |
| Editor handoff (segments + overlays + manifest/FCPXML) | [`editor-handoff.md`](../editor-handoff.md) | **Shipped** — export + manifest + rebuild (VS-24) + FCPXML (VS-25) |
| Multiple source videos | [`multiple-sources.md`](../multiple-sources.md) | **Shipped** (VS-26) |
| FCP transition suggestions | [`transitions.md`](../transitions.md) | **Shipped** (VS-28) — opt-in `transitions` → FCP `<transition>`s (Cross Dissolve + Fade To Color) + baked segment handles; DTD-valid |
| Multi-cam editing | [`multicam.md`](../multicam.md), [`multicam-sync.md`](../multicam-sync.md) | **Shipped** — sync, group proposal, angle switching → flat-timeline export, drift correction applied on export, true FCPXML mc-clip asset (VS-27/29/30/31/32/33); **FCP import validated against the real app (VS-36)** |
| Edit awareness / auto multi-cam cutting | [`audio-events.md`](../audio-events.md), [`visual-saliency.md`](../visual-saliency.md), [`multicam-auto-cut.md`](../multicam-auto-cut.md) | **Partial** — specs done (VS-41/42/43); **audio-events Tier-1 shipped (VS-44)**; visual saliency (VS-45), selector (VS-46), integration (VS-47) pending |

The core pipeline plus the editor handoff (export + FCPXML) and multi-source
input are shipped. **Multi-cam** is shipped end to end (VS-27/29/30/31/32/33):
audio sync, group proposal, angle switching → a synced flat-timeline export
(continuous master-audio track + FCPXML), drift detection + retime correction
applied on export, and a true FCPXML `<mc-clip>` multicam asset (FCP import is a
manual validation step). Design-only: **FCP transition suggestions**
([`transitions.md`](../transitions.md), VS-23) — see its doc + follow-up tickets.

## Per-area notes

- **Platform & dependencies (R2)** — Shipped. `bin/video-studio.mjs` enforces
  macOS, checks each tool, and offers brew installs. Claude-describes-frames is
  the default; Ollama is genuinely optional.
- **Launcher (R3)** — Shipped. All documented flags (`--check`, `--no-launch`,
  `--skills-only`, `--yes`, `--help`) implemented; skill install does the
  `{{TOOLKIT_DIR}}` substitution.
- **Scene analyzer (R4)** — Shipped. Frame-accurate detection, resumable
  state keyed to path+size+mtime, atomic writes, classified resumable errors.
  `src/analyzer.ts` is now just orchestration (149 LOC); the pure/testable logic
  is split into `src/scene-math.ts` (math), `src/analyzer-cli.ts` (arg parsing),
  `src/analyzer-state.ts` (state persistence), and `src/resumable-error.ts`
  (error classification) — all unit-tested to 100%. The ffmpeg/ollama wrappers
  live in `src/ffmpeg.ts` / `src/ollama.ts` (manual-tested).
- **Overlay generator (R5)** — Shipped. All styles/positions/options present;
  pure arg-parse + SVG/HTML assembly extracted to `tools/caption-format.mjs`
  and unit-tested to 100%; the Chromium render stays in `render-caption.mjs`.
- **The skill (R6)** — Shipped as `skills/video-studio/SKILL.md`. This is prose
  guidance for Claude rather than executable code, so it's verified by review +
  the manual test plan, not unit tests. **R6.5** (keep the AI-interpretation
  intermediates — `timeline.json` descriptions + `<dataDir>/transcripts/`) is a
  skill-guidance convention; committed examples live in `docs/samples/`
  (`tears-of-steel.scenes.json` + `.transcript.{json,txt}`).
- **Quality gates (R7)** — Shipped. Vitest 100% on the two pure modules; manual
  test plan for the pipeline; `npm run check` + CI; tag-driven release with
  provenance.
- **Editor handoff (Shipped)** — `tools/export-project.mjs` turns a cut spec into
  segment files (ProRes 422 HQ) + overlay files (ProRes 4444 alpha) + a JSON
  manifest + `rebuild.sh` (VS-24) **and** a Final Cut Pro `.fcpxml` (VS-25). Pure
  logic + 100% tests in `tools/export-manifest.mjs` + `tools/fcpxml.mjs`. See
  [`editor-handoff.md`](../editor-handoff.md).
- **Multiple sources (Shipped)** — `tools/analyze-sources.mjs` expands files/folders
  into a source pool, analyzes each independently, and writes `sources.json`
  (sources + scenes tagged with `sourceId`). Pure id/manifest logic + 100% tests
  in `tools/sources.mjs` (VS-26). Cuts draw across sources by `(sourceId, in, out)`.
- **Edit awareness / auto multi-cam cutting (Partial)** — three specs make the
  multi-cam edit follow the music + action instead of just speech. The **audio-events
  pass is shipped (Tier 1, VS-44)**: `tools/audio-events.mjs` (pure, 100% tested) +
  `tools/analyze-audio-events.mjs` (ffmpeg CLI) emit `audio-events.json` — loudness
  envelope, onsets, quiet, and whisper-gated vocal/instrumental sections
  ([`audio-events.md`](../audio-events.md), R-AE; Tier 2 spectral/novelty = VS-49,
  stems = VS-48). Still design-only: per-angle
  visual saliency ([`visual-saliency.md`](../visual-saliency.md), R-VS, VS-42 → VS-45),
  and an audio+visual angle selector that emits the existing `switches`
  ([`multicam-auto-cut.md`](../multicam-auto-cut.md), R-AC, VS-43 → VS-46), wired into
  the workflow in VS-47. All within the current ffmpeg/whisper/Ollama/pure-JS-DSP
  stack; stem separation (Demucs) deferred. Grounded on the BYAM clip
  (`external/multi-cam/`).
- **FCP transition suggestions (Shipped, VS-28)** — opt-in `transitions` on the cut
  spec emit FCP `<transition>` elements at the chosen cuts in the editor-handoff
  `.fcpxml` (Cross Dissolve + Fade To Color; "Dip to Color" alias), centered on the
  cut with a `<filter-audio>` Audio Crossfade. The prerequisite **segment handles**
  ship too: `buildManifest` records per-segment handles, `segmentArgs` bakes them,
  `rebuildScript` trims them (concat `inpoint`/`outpoint`). Effect uids captured from
  a real FCP export; output validates against FCP's bundled `FCPXMLv1_10.dtd`. The
  AI picks transitions per cut (SKILL.md §7, hard-cut by default). More built-in
  transitions = VS-50. [`transitions.md`](../transitions.md).
- **Multi-cam (Shipped)** — audio sync **shipped** (VS-27):
  `tools/sync-multicam.mjs` (ffmpeg mono extract + run) over `tools/multicam-dsp.mjs`
  (pure FFT cross-correlation, normalized-peak confidence gate, drift fit) +
  `tools/multicam.mjs` (group-manifest + angle-cut math), 100% tests. Emits
  `multicam.json`; audio-only
  members are the sync reference + master audio; all alignment is seconds-based
  (mismatched fps need no special case). Offsets are sub-sample-refined and a
  GCC-PHAT (`--feature phat`) option exists for low SNR (VS-32). **Group proposal**
  from a source pool (folder / overlapping recording windows / filename) ships as
  `propose-groups` + `tools/multicam-groups.mjs` (VS-31). Long-take **drift** is
  detected, flagged, a **retime correction computed** (`rateCorrection` +
  start-anchored `correctedOffsetSeconds`, VS-30) **and applied on export** — a
  drifting angle segment is `setpts`-stretched to fill its slot (VS-33). **Angle
  switching** ships via `expandMulticamGroup` → an editor-handoff cut spec (silent
  video angle-segments over a continuous master-audio `audioTrack`), exported with
  the master audio muxed under the switching angles + on an FCPXML connected lane,
  driven from the skill (VS-29). A **true FCPXML `<mc-clip>` multicam asset**
  (`export-multicam-fcpxml` + `buildMulticamFcpxml`) emits a live re-cuttable angle
  clip referencing the original media (VS-33; FCP import is a manual validation).
  See [`multicam.md`](../multicam.md) + [`multicam-sync.md`](../multicam-sync.md).

## Known gaps / follow-ups

- **`promo-assets/` packaging (VS-8) — Resolved.** The three example *sources*
  now ship via the `promo-assets/*.mjs` + `promo-assets/*.sh` globs (generated
  SVGs, the nested `node_modules`, and the nested `package.json` are excluded),
  so the `$TOOLKIT/promo-assets/*` references in `SKILL.md` resolve for
  npm-installed users. The example scripts were made portable (published
  `domotion-svg` instead of a local checkout; env-configurable `ICONS_DIR` /
  `OUT_DIR` / `TMPDIR` / `SRC`; no machine paths). Guarded by
  `tests/packaging.test.ts`.
- **No automated coverage of the pipeline** — by design (external tools); this
  is the manual test plan's job. Re-evaluate if a reliable harness becomes
  feasible.

## Update triggers

Update this file when you: add/change/remove a requirement in
`../requirements.md`; ship a Design-only item; regress or defer a Shipped one;
or close/open a follow-up that changes an area's status.

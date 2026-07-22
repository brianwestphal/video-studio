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
| Quality gates | R7.1–R7.5 | **Shipped** — incl. feature/requirement coverage (VS-58) |
| Feature/requirement coverage (2nd axis) | [`feature-coverage.md`](../feature-coverage.md) (R-EC) | **Shipped** (VS-58) — `check:features` + `conventions.test.ts` |
| Editor handoff (segments + overlays + manifest/FCPXML) | [`editor-handoff.md`](../editor-handoff.md) | **Shipped** — export + manifest + rebuild (VS-24) + FCPXML (VS-25) |
| Multiple source videos | [`multiple-sources.md`](../multiple-sources.md) | **Shipped** (VS-26) |
| FCP transition suggestions | [`transitions.md`](../transitions.md) | **Shipped** (VS-28, VS-50) — opt-in `transitions` → FCP `<transition>`s (16 built-ins: dissolves/fades, movements, wipes, insets/splits, Static) + baked segment handles; DTD-valid. |
| Render transitions into the video (no FCP) | [`render-transitions.md`](../render-transitions.md) | **Shipped** (VS-54 + VS-55, R-RT1–R-RT9) — `render-transitions` bakes the transitions into a finished video with **no FCP**, reusing the baked handles. **Windowed re-encode** (default): re-encode only each transition overlap + stream-copy-concat the bodies (cost ≈ Σ transition duration); `--full-chain` for the whole-timeline graph. **Native Tier A/B/C**: Tier A direct `xfade`, Tier B `xfade=custom` (chevron/static), Tier C overlay-mask/crop-slide (inset/split). |
| Multi-cam editing | [`multicam.md`](../multicam.md), [`multicam-sync.md`](../multicam-sync.md) | **Shipped** — sync, group proposal, angle switching → flat-timeline export, drift correction applied on export, true FCPXML mc-clip asset (VS-27/29/30/31/32/33); **FCP import validated against the real app (VS-36)** |
| FCP-incompatible source audio detection | [`fcp-audio-compat.md`](../fcp-audio-compat.md) | **Shipped** (VS-40 + VS-53) — detect Pro Tools / BWF WAVs (non-16-byte PCM `fmt `, `bext`/`minf`/`elm1`/`JUNK`…) that FCP imports silently; `sync-multicam` + `export-multicam-fcpxml` warn with the `ffmpeg` fix, or with `--fcp-normalize-audio` re-encode to a canonical `<name>.fcp.wav` sidecar + repoint (R-FA1–R-FA5). |
| Desktop app (VS-76 initiative) | [`desktop-app.md`](../desktop-app.md), [`desktop-app-agent-bridge.md`](../desktop-app-agent-bridge.md), [`desktop-app-permissions.md`](../desktop-app-permissions.md) | **Partial** — native Tauri shell, five-stage project rail, sidecar, core screens, and Claude/Codex/Ollama Auto backends are built. Completed cuts go Design → Export with optional inline timeline editing (VS-113), and recent projects persist and reopen from New Project (VS-112). The app-owned permission layer is shipped end-to-end (VS-92/97). Remaining work is tracked in the screen/polish tickets. |
| Captions and subtitles | [`captions.md`](../captions.md) | **Design complete** (VS-111) — normalized timed text from Whisper/SRT/WebVTT/TTML; explicit sidecar, selectable embedded-track, and burn-in modes; responsive styling, preview, and output validation. Implementation is split into follow-up tickets. |
| Kerfjs UI standard | [`kerfjs-ui.md`](../kerfjs-ui.md) | **Foundation shipped; migrations planned** (VS-115/121) — kerfjs runtime, TSX typecheck/bundles, recommended lint rules, shared root utility, component test, and AI skill are installed. The Tauri webview and multi-camera reviewer migrations remain VS-119/120. |
| Edit awareness / auto multi-cam cutting | [`audio-events.md`](../audio-events.md), [`visual-saliency.md`](../visual-saliency.md), [`multicam-auto-cut.md`](../multicam-auto-cut.md) | **Shipped** (BYAM demo manual) — specs done (VS-41/42/43); **audio-events Tier-1 + Tier-2 shipped (VS-44, VS-49)**; **per-angle visual saliency shipped (VS-45)** — `analyze-visual-saliency` → `saliency.json` (motion pass gates Ollama vision, pure core 100%-tested, R-VS1–R-VS5); **angle-switch selector shipped (VS-46)** — `tools/multicam-autocut.mjs` (pure, 100%-tested) + `propose-switches` CLI emit `switches.json` (R-AC1–R-AC6); **workflow integration shipped (VS-47)** — `export-multicam-fcpxml`/`render-multicam-preview` accept `--switches`, rationale surfaced, hand-editable override (R-AC7, R-MC7); BYAM demonstration run; **shot-length policy shipped (VS-62)** — default max 8s/min 0.5s + instrumental long-take exception (R-AC8); **per-switch review signal shipped (VS-63)** — runnerUp/confidence/flagged (R-AC9); **review UI shipped (VS-65)** — `review-switches.mjs` local server + `review-model.mjs` (pure, 100%) surface flagged cuts with ±2s previews, write picks back to switches.json + history ([`multicam-review-ui.md`](../multicam-review-ui.md), R-RUI1–6); **locks + shot-type variety shipped (VS-66)** — `autoCut` honors `locks` + a shot-type variety penalty, `shotType` in the vision schema; **review-UI re-propose shipped (VS-67)** — opt-in button re-flows the still-auto cuts around confirmed picks (R-RUI7); **review-UI interactive playback shipped (VS-71)** — per-segment synchronized transport, one audio-focus clip at a time, fullscreen, audio-bearing previews (R-RUI8); **section-of-interest scrubber band shipped (VS-72)**; **whole-video assembled timeline preview shipped (VS-73)** — client-side multi-cam player (HTTP-Range sources, live pick updates), angle-colored bar with flagged sections (R-RUI9); **manual review editing shipped (VS-74)** — force-add any cut (forceKeys/`/add-review`), split at the playhead (`splitSwitch`/`/split`), timeline docked as a collapsible nav-bar drawer (R-RUI10) |

The core pipeline plus the editor handoff (export + FCPXML) and multi-source
input are shipped. **Multi-cam** is shipped end to end (VS-27/29/30/31/32/33):
audio sync, group proposal, angle switching → a synced flat-timeline export
(continuous master-audio track + FCPXML), drift detection + retime correction
applied on export, and a true FCPXML `<mc-clip>` multicam asset (FCP import is a
manual validation step). **FCP transition suggestions** are shipped too (VS-28 +
the full palette in VS-50). The "edit awareness" auto-cut initiative is partial
(audio-events Tier 1 shipped, VS-44).

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
- **Quality gates (R7)** — Shipped. Vitest 100% l/b/f/s on the pure modules in
  `vitest.config.ts` `coverage.include`; manual test plan for the pipeline;
  `npm run check` + CI; tag-driven release with provenance. **R7.5 — feature/
  requirement coverage (the second axis, VS-58):** `tools/requirement-coverage.mjs`
  (pure, 100% tested) extracts the requirement index from the `- **R<id>**`
  definitions across `docs/*.md` and audits it against a coverage manifest mapping
  every requirement to how a regression is caught (`unit`/`manual`/`review`/`gate`/
  `deferred`); `npm run check:features` + `tests/conventions.test.ts` fail on any
  documented requirement with no coverage decision (or a `unit` entry with no test).
  Line coverage is a floor, not a ceiling. See
  [`feature-coverage.md`](../feature-coverage.md) (R-EC1–R-EC4).
- **Editor handoff (Shipped)** — `tools/export-project.mjs` turns a cut spec into
  segment files (ProRes 422 HQ) + overlay files (ProRes 4444 alpha) + a JSON
  manifest + `rebuild.sh` (VS-24) **and** a Final Cut Pro `.fcpxml` (VS-25). Pure
  logic + 100% tests in `tools/export-manifest.mjs` + `tools/fcpxml.mjs`. See
  [`editor-handoff.md`](../editor-handoff.md).
- **Multiple sources (Shipped)** — `tools/analyze-sources.mjs` expands files/folders
  into a source pool, analyzes each independently, and writes `sources.json`
  (sources + scenes tagged with `sourceId`). Pure id/manifest logic + 100% tests
  in `tools/sources.mjs` (VS-26). Cuts draw across sources by `(sourceId, in, out)`.
- **Edit awareness / auto multi-cam cutting (Shipped; BYAM demo manual)** — three specs make the
  multi-cam edit follow the music + action instead of just speech. The **audio-events
  pass is shipped (Tier 1 + Tier 2, VS-44 + VS-49)**: `tools/audio-events.mjs` (pure,
  100% tested) + `tools/analyze-audio-events.mjs` (ffmpeg CLI) emit
  `audio-events.json` — loudness envelope, onsets, quiet, whisper-gated
  vocal/instrumental sections, **per-section spectral descriptors
  (centroid/rolloff/flux/ZCR/bands) and structural `"section"` events from spectral
  novelty** ([`audio-events.md`](../audio-events.md), R-AE1–R-AE8; optional stems =
  VS-48). **Per-angle visual saliency is shipped (VS-45)**:
  `tools/visual-saliency.mjs` (pure, 100% tested) + `tools/analyze-visual-saliency.mjs`
  emit `saliency.json` — per angle, per window on the group clock, a cheap ffmpeg
  motion pass (`tblend`+`signalstats`) gates Ollama vision (`performer`/`instrument`/
  `motion`/`framing`/`presence` + labels + a combined `saliency`), with section-
  boundary/high-motion gating + a per-run cap ([`visual-saliency.md`](../visual-saliency.md),
  R-VS1–R-VS5). The **audio+visual angle selector is shipped (VS-46)**:
  `tools/multicam-autocut.mjs` (pure, 100% tested) + `propose-switches` emit the
  existing `switches` list + a per-switch `rationale`
  ([`multicam-auto-cut.md`](../multicam-auto-cut.md), R-AC1–R-AC6). The **workflow
  integration is shipped (VS-47)**: `export-multicam-fcpxml`/`render-multicam-preview`
  read it via `--switches` (glue `switchesFromDoc` in `multicam.mjs`), the rationale is
  surfaced, and the plain `switches.json` is a hand-editable override (R-AC7, R-MC7);
  the BYAM demonstration has been run (favors guitar on riffs / singer on vocals). The
  **shot-length policy is shipped (VS-62)**: default max 8s / min 0.5s with an
  instrumental **long-take exception** (dominant angle may hold to `longTakeMaxSeconds`
  during solos/oners; vocal holds always cut at max) — R-AC8. The **per-switch review
  signal is shipped (VS-63)**: `autoCut` flags near-tie / low-vision-confidence cuts with
  a `runnerUp` + `confidence` (R-AC9). The **local review UI is shipped (VS-65)**:
  `tools/review-switches.mjs` (server + page + ffmpeg ±2s previews) over the pure
  `tools/review-model.mjs` (100% tested) surfaces flagged cuts and writes the user's
  picks back to switches.json in place (+ a change history) —
  ([`multicam-review-ui.md`](../multicam-review-ui.md), R-RUI1–6). The **downstream
  re-evaluation model is shipped (VS-66)**: `autoCut` accepts `locks` (pinned user picks
  the selection re-flows around) + a soft shot-type variety penalty, and `shotType`
  (wide/medium/close) is now part of the saliency vision schema (R-RUI7). The **review
  UI re-propose is shipped (VS-67)**: an opt-in "Re-propose downstream" button (with
  `--audio-events` + `--saliency`) re-runs `autoCut` with the user's picks as locks so
  the still-auto cuts re-flow, written only on Save. Follow-up: a saliency performer/instrument
  mis-score fix (VS-64). All within the current ffmpeg/whisper/Ollama/pure-JS-DSP stack;
  stem separation (Demucs) deferred.
  Grounded on the BYAM clip (`external/multi-cam/`).
- **FCP transition suggestions (Shipped, VS-28)** — opt-in `transitions` on the cut
  spec emit FCP `<transition>` elements at the chosen cuts in the editor-handoff
  `.fcpxml` (Cross Dissolve + Fade To Color; "Dip to Color" alias), centered on the
  cut with a `<filter-audio>` Audio Crossfade. The prerequisite **segment handles**
  ship too: `buildManifest` records per-segment handles, `segmentArgs` bakes them,
  `rebuildScript` trims them (concat `inpoint`/`outpoint`). Effect uids captured from
  a real FCP export; output validates against FCP's bundled `FCPXMLv1_10.dtd`. The
  AI picks transitions per cut (SKILL.md §7, hard-cut by default). The full
  16-transition palette (movements, wipes, insets/splits, Static) was added in
  **VS-50**. **`render-transitions` (VS-54 + VS-55)** also bakes the transitions into a
  finished video with **no FCP** — `tools/transitions-render.mjs` (pure: recipe maps +
  full-chain & **windowed** render plans + `windowedClipFilter`, 100% tested) +
  `tools/render-transitions.mjs` (ffmpeg I/O) reuse the baked handles. The default
  **windowed** render re-encodes only each transition overlap and stream-copy-concats
  the bodies (cost ≈ Σ transition duration); `--full-chain` keeps the whole-timeline
  graph. **Native Tier A/B/C**: Tier A direct `xfade`, Tier B `xfade=custom`
  (chevron/static), Tier C overlay-mask/crop-slide (inset/split). See
  [`render-transitions.md`](../render-transitions.md) + [`transitions.md`](../transitions.md) §8.
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
- **FCP-incompatible source audio detection (Shipped, VS-40 + VS-53)** —
  `tools/wav-compat.mjs` (pure RIFF parse + classify + sidecar-path/ffmpeg-argv
  helpers, 100% tests) + `tools/wav-compat-io.mjs` (header read + warn/normalize)
  detect Pro Tools / BWF WAVs that FCP's importer rejects (non-16-byte PCM `fmt `,
  `bext`/`minf`/`elm1`/`regn`/`umid`/`JUNK` chunks) — the silent "Invalid edit with
  no respective media" case from VS-36. `sync-multicam` and `export-multicam-fcpxml`
  **warn** on their audio members with the canonical `ffmpeg` fix by default, or
  with **`--fcp-normalize-audio`** re-encode to a canonical `<name>.fcp.wav` sidecar
  next to the source and **repoint** the manifest / FCPXML asset (reusing an
  up-to-date sidecar). See [`fcp-audio-compat.md`](../fcp-audio-compat.md)
  (R-FA1–R-FA5).

- **Desktop app (VS-76; partial implementation)** — a native app front door over the
  unchanged engine, so non-technical creatives get timelines + buttons instead of `--flags`.
  Approved concept + wireframe (VS-78) in [`../investigations/ui-app.md`](../investigations/ui-app.md).
  Requirements exist for the three high-priority foundation tickets:
  **shell + project model + stage nav + Node sidecar host** ([`../desktop-app.md`](../desktop-app.md),
  R-APP, VS-80); a **pluggable AI agent control bridge** that powers the Auto lane —
  **Claude / Codex / Ollama** behind one interface, agent **optional** (timeline editing needs
  none), Claude via `@anthropic-ai/claude-agent-sdk` first, structured events → activity
  feed, backend-agnostic tool-permission choke point
  ([`../desktop-app-agent-bridge.md`](../desktop-app-agent-bridge.md), R-CB1–11, VS-83); and
  the **app-owned permission & safety layer** — a pure category classifier + persisted
  "always allow this kind" rules + a Permissions screen, independent of any agent's own
  permissions ([`../desktop-app-permissions.md`](../desktop-app-permissions.md), R-PERM1–12,
  VS-85). **Maintainer forks settled 2026-07-03** (`desktop-app.md` §8): subdir of this repo;
  agent optional + pluggable; optional timeline editing; assume-nothing (detect + guide, incl. Node).
  All requirements are `deferred` in the coverage manifest; when built, the doc-flagged pure
  cores (stage-state derivation, sidecar protocol framing, normalized event→feed mapping, the
  permission classifier/matcher) become 100%-unit-tested per convention. VS-80/83/85 are
  spec-complete; the spike (VS-79) + build tickets carry the implementation.

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

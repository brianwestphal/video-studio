# Codebase Map (AI summary)

A synthesized orientation for an AI assistant starting a fresh session. Keep it
in sync with reality — when source/code and this doc disagree, the code wins and
this doc should be corrected in the same change. Update triggers are listed at
the bottom.

## What this is

A macOS toolkit + Claude skill that turns long videos into promo cuts. See
[`../requirements.md`](../requirements.md) for the authoritative behavior spec
and [`requirements-summary.md`](requirements-summary.md) for status.

## Directory tree (tracked, meaningful paths)

```
.
├── bin/
│   └── video-studio.mjs        # launcher / doctor / skill installer (the `video-studio` bin)
├── src/
│   ├── analyzer.ts             # scene analyzer entry + orchestration (compiled → dist/analyzer.js, the `video-scene-analyzer` bin)
│   ├── analyzer-cli.ts         # pure CLI arg parsing + usage + Config (unit-tested)
│   ├── analyzer-state.ts       # resumable-run state persistence (unit-tested)
│   ├── resumable-error.ts      # ResumableError + classifyOllamaError (pure, unit-tested)
│   ├── ffmpeg.ts               # ffprobe/ffmpeg wrappers: probe, scene-detect, frame-extract (I/O, manual-tested)
│   ├── ollama.ts               # analyzeFrame — Ollama vision call (I/O, manual-tested)
│   └── scene-math.ts           # pure fps/timecode/scene-merge math (unit-tested)
├── tools/
│   ├── render-caption.mjs      # caption/CTA → animated SVG (Chromium pipeline)
│   ├── caption-format.mjs      # pure arg-parse + SVG/HTML assembly (unit-tested)
│   ├── export-project.mjs      # editor handoff: cut spec → segments/overlays/manifest/rebuild.sh/fcpxml (I/O)
│   ├── export-manifest.mjs     # pure manifest + ffmpeg-command + rebuild-script logic, incl. transition handles (unit-tested)
│   ├── fcpxml.mjs              # pure FCPXML generation from the manifest, incl. FCP <transition>s + effect uids (unit-tested)
│   ├── analyze-sources.mjs     # multiple-source input: files/folders → per-source analysis → sources.json (I/O)
│   ├── sources.mjs             # pure source-id + sources-manifest logic (unit-tested)
│   ├── sync-multicam.mjs       # multi-cam audio sync: ffmpeg mono extract + cross-correlation → multicam.json (I/O)
│   ├── multicam-dsp.mjs        # pure DSP: FFT/GCC-PHAT cross-correlation + sub-sample peak + confidence + drift fit/correction (unit-tested)
│   ├── multicam.mjs            # pure group-manifest + angle-cut assembly: classifySync, buildGroupManifest, resolveAngleCuts, expandMulticamGroup, switchesFromDoc (unit-tested)
│   ├── propose-groups.mjs      # suggest multicam groups from sources.json (stat-based timestamps) (I/O)
│   ├── multicam-groups.mjs     # pure group-proposal heuristics: folder / time-window / filename (unit-tested)
│   ├── export-multicam-fcpxml.mjs # multicam.json → true FCP <mc-clip> multicam FCPXML (I/O over buildMulticamFcpxml; --switch flags or --switches <switches.json>; black filler for angle leading gaps)
│   ├── render-multicam-preview.mjs # multicam.json + switches (--switch or --switches <switches.json>) → flat preview MP4 of the angle cut (I/O over resolveAngleCuts)
│   ├── audio-events.mjs        # pure non-speech audio-events DSP: RMS envelope, onsets, vocal/instrumental sectioning, spectral descriptors + structural novelty, schema (unit-tested, VS-44/49)
│   ├── analyze-audio-events.mjs # audio/video (+ whisper transcript) → audio-events.json (ffmpeg I/O over audio-events.mjs)
│   ├── wav-compat.mjs          # pure RIFF parse + FCP-compat classification + sidecar path/ffmpeg-argv helpers for WAV source audio (unit-tested, VS-40/53)
│   ├── wav-compat-io.mjs       # thin I/O: read a file's RIFF header, warn (or with --fcp-normalize-audio re-encode + repoint) FCP-incompatible WAVs (over wav-compat.mjs)
│   ├── transitions-render.mjs  # pure: transition→recipe maps (Tier A xfade / B custom-expr / C overlay-mask) + full-chain & windowed render plans + filter_complex (unit-tested, VS-54/55)
│   ├── render-transitions.mjs  # bake transitions into a finished video via ffmpeg — no FCP; windowed re-encode (default) or --full-chain (I/O over transitions-render.mjs)
│   ├── visual-saliency.mjs     # pure: per-angle saliency windowing + group-clock map + motion norm + vision-reply parse + gating + schema (unit-tested, VS-45)
│   ├── analyze-visual-saliency.mjs # per-angle saliency.json: ffmpeg motion pass gates Ollama vision over multicam angles (I/O over visual-saliency.mjs)
│   ├── multicam-autocut.mjs    # pure: auto angle-switch selection (audio-events + saliency → switches + rationale) + evaluate() metrics + shot-length policy w/ instrumental long-take exception + per-switch review signal (unit-tested, VS-46/62/63)
│   ├── propose-switches.mjs    # thin CLI: read multicam.json + audio-events.json + saliency.json → switches.json (+ prints rationale); feeds the exporters via --switches (I/O over multicam-autocut.mjs, VS-46/47)
│   ├── review-model.mjs        # pure: review-UI core — flagged-segment derivation + candidate angles + preview windows + apply-choice/history (unit-tested, VS-65)
│   ├── review-switches.mjs     # I/O: local server + page + ffmpeg ±2s previews to review flagged cuts, write picks back to switches.json + history (over review-model.mjs, VS-65)
│   ├── requirement-coverage.mjs # pure: requirement-index extraction + the feature-coverage manifest + audit (unit-tested, VS-58)
│   └── check-features.mjs      # feature/requirement coverage report + gate (I/O over requirement-coverage.mjs); `npm run check:features`
├── skills/
│   └── video-studio/SKILL.md   # the pipeline Claude follows — primary interface
├── tests/
│   ├── scene-math.test.ts      # unit tests for src/scene-math.ts
│   ├── analyzer-cli.test.ts    # unit tests for src/analyzer-cli.ts
│   ├── analyzer-state.test.ts  # unit tests for src/analyzer-state.ts
│   ├── resumable-error.test.ts # unit tests for src/resumable-error.ts
│   ├── caption-format.test.ts  # unit tests for tools/caption-format.mjs
│   ├── export-manifest.test.ts # unit tests for tools/export-manifest.mjs
│   ├── fcpxml.test.ts          # unit tests for tools/fcpxml.mjs
│   ├── sources.test.ts         # unit tests for tools/sources.mjs
│   ├── multicam-dsp.test.ts    # unit tests for tools/multicam-dsp.mjs
│   ├── multicam.test.ts        # unit tests for tools/multicam.mjs
│   ├── multicam-groups.test.ts # unit tests for tools/multicam-groups.mjs
│   ├── audio-events.test.ts   # unit tests for tools/audio-events.mjs
│   ├── wav-compat.test.ts     # unit tests for tools/wav-compat.mjs
│   ├── transitions-render.test.ts # unit tests for tools/transitions-render.mjs
│   ├── visual-saliency.test.ts # unit tests for tools/visual-saliency.mjs
│   ├── multicam-autocut.test.ts # unit tests for tools/multicam-autocut.mjs
│   ├── review-model.test.ts    # unit tests for tools/review-model.mjs
│   ├── requirement-coverage.test.ts # unit tests for tools/requirement-coverage.mjs
│   ├── conventions.test.ts     # feature-coverage audit gate + dependency/coverage-include invariants (VS-58)
│   └── packaging.test.ts       # guards machine-path leaks + the promo-assets packaging
├── promo-assets/               # worked-example assembly scripts (sources shipped via promo-assets/*.{mjs,sh}; generated SVGs + nested node_modules excluded)
├── docs/
│   ├── requirements.md         # source-of-truth requirements (shipped pipeline)
│   ├── feature-coverage.md     # the second coverage axis: requirement index + manifest + check:features (R7.5/R-EC, VS-58)
│   ├── editor-handoff.md       # export segments + overlays + manifest + FCPXML (shipped, VS-24/25)
│   ├── multiple-sources.md     # draw from many files/folders (shipped, VS-26)
│   ├── transitions.md          # FCP transition suggestions in the FCPXML — shipped VS-28/50 (full palette + handles)
│   ├── render-transitions.md   # bake transitions into the video, no FCP — windowed re-encode + native Tier A/B/C (R-RT, VS-54/55)
│   ├── multicam.md             # audio-synced multi-cam design (VS-19); sync shipped VS-27; FCP import validated VS-36
│   ├── multicam-sync.md        # audio sync tool requirements + research findings (VS-27, shipped)
│   ├── audio-events.md         # DESIGN: non-speech/musical audio events spec (R-AE, VS-41 → build VS-44)
│   ├── visual-saliency.md      # per-angle "what's worth showing" — shipped (R-VS, VS-42 design → VS-45 build)
│   ├── multicam-auto-cut.md    # DESIGN: audio+visual → angle-selection model emitting switches (R-AC, VS-43 → build VS-46/47/62/63)
│   ├── multicam-review-ui.md   # review low-confidence auto-cuts in a local web UI (R-RUI; flag signal R-AC9 + UI R-RUI1-6 shipped VS-63/65, downstream re-eval R-RUI7 VS-66)
│   ├── releasing.md            # release + npm trusted-publisher setup
│   ├── manual-test-plan.md     # manual checklist for the external-tool pipeline
│   ├── media/                  # README demo media (docs-only; gitignored binaries) — from Tears of Steel (CC BY 3.0)
│   ├── samples/                # committed reference samples (scene descriptions + transcript) from Tears of Steel
│   └── ai/
│       ├── codebase-map.md         # ← this file
│       └── requirements-summary.md # synthesized requirements status
├── .github/workflows/
│   ├── ci.yml                  # lint/typecheck/test/build on push+PR
│   └── release.yml             # tag-driven GitHub Release + npm publish (OIDC)
├── scripts/
│   ├── release.sh              # interactive stable + --beta release flow
│   ├── gen-readme-media.sh     # regenerate README demo media from external/tears-of-steel.mp4
│   └── gen-readme-samples.sh   # regenerate the README transcript sample (whisper)
├── eslint.config.mjs           # flat ESLint config (TS + Node-ESM passes)
├── vitest.config.ts            # unit tests + 100% coverage on the pure modules
├── tsconfig.json               # NodeNext, strict; rootDir src/ → outDir dist/
├── CHANGELOG.md · LICENSE · README.md
└── CLAUDE.md                   # project instructions for AI assistants
```

Generated/ignored: `dist/`, `coverage/`, `node_modules/`, `analysis-data/`,
`frames/`, `.release-state.json`, `.hotsheet/` (except settings), and
`external/` (the gitignored sample video, e.g. `external/tears-of-steel.mp4`,
used by the `gen-readme-*` scripts).

## Entry points

| Entry | File | Invoked by |
|-------|------|-----------|
| `video-studio` bin | `bin/video-studio.mjs` | `npx video-studio` / launcher |
| `video-scene-analyzer` bin | `dist/analyzer.js` (from `src/analyzer.ts`) | the skill, step 1 |
| `render-caption` tool | `tools/render-caption.mjs` | the skill, step 4 |
| the skill | `skills/video-studio/SKILL.md` | Claude (`/video-studio`) |

## Data shapes (analyzer)

- **Persisted state** `<dataDir>/state.json` (`PersistedState`, `STATE_VERSION = 3`,
  both in `src/analyzer-state.ts`): `version`, `videoPath`, `videoSize`,
  `videoMtimeMs`, `duration`, `fps`, `scenes: {startFrame,endFrame}[]`,
  `descriptions: Record<sceneIndex,string>`. Reused only if path+size+mtime match
  the current video.
- **Timeline record** `<dataDir>/timeline.json` + `--out` (`SceneSegment`, in `src/analyzer.ts`):
  `start`/`end` (`HH:MM:SS:FF`), `startFrame`, `endFrame`, `startSeconds`,
  `endSeconds`, `framePath`, `description`.

## Build / test / lint

| Task | Command |
|------|---------|
| Build (tsc → `dist/`) | `npm run build` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit tests + coverage | `npm test` |
| Feature/requirement coverage | `npm run check:features` |
| Everything | `npm run check` (lint → typecheck → test → check:features → build) |
| Run launcher | `npm run studio` · doctor `npm run doctor` |

Coverage runs on **two axes**. (1) Line/branch coverage is enforced (100% l/b/f/s)
on the pure modules in `vitest.config.ts` `coverage.include` (the authoritative
list — read it from the file): the `src/` analyzer cores plus the pure `tools/*.mjs`
(`caption-format`, `export-manifest`, `fcpxml`, `sources`, `multicam*`,
`audio-events`, `wav-compat`, `transitions-render`, `visual-saliency`,
`multicam-autocut`, `requirement-coverage`). The I/O code (`analyzer.ts`
orchestration, `ffmpeg.ts`, `ollama.ts`, the `bin/` launcher, `render-caption.mjs`'s
Chromium path, the `analyze-*` + `propose-switches` + `check-features` CLIs) is
manual-test territory. (2) **Feature/requirement coverage** (`docs/feature-coverage.md`,
`tools/requirement-coverage.mjs`) asserts every documented requirement is tested or
consciously classified — line coverage is a floor, not a ceiling.

## Settings / config

- `tsconfig.json` — NodeNext modules, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`; `rootDir: src` → `outDir: dist`.
- `eslint.config.mjs` — `.mjs` (package is `type: commonjs`); 3 passes:
  type-aware TS on `src/**`, parser-only TS on `tests/**`, Node-ESM on
  `bin/`+`tools/`+`promo-assets/`+`tests/**.mjs`. Ignores `dist`, `coverage`,
  `analysis-data`, `frames`, `promo-assets/node_modules`.
- `vitest.config.ts` — node env; coverage `include` + 100% thresholds.
- Analyzer tuning constants: `SCENE_THRESHOLD = 0.4` (`src/analyzer.ts`);
  `DEFAULT_MODEL = "gemma4:12b"` + `DEFAULT_DATA_DIR` (`src/analyzer-cli.ts`);
  `STATE_VERSION = 3` (`src/analyzer-state.ts`); `MIN_SCENE_SEC = 1.0`
  (`src/scene-math.ts`); multi-cam sync defaults (sample rate 8000, accept 0.8 /
  reject 0.5, drift-min 600 s) in `tools/sync-multicam.mjs` and
  `DRIFT_WARN_PPM = 100` in `tools/multicam.mjs`.

## Where do I look for X?

| Need | Look in |
|------|---------|
| fps parsing / timecode / scene merging | `src/scene-math.ts` |
| analyzer orchestration (the run pipeline) | `runAnalysis` in `src/analyzer.ts` |
| analyzer CLI flags / usage | `src/analyzer-cli.ts` (`parseArgs`) |
| resumable-run state load/save/match | `src/analyzer-state.ts` |
| ffmpeg probe / scene-detect / frame-extract | `src/ffmpeg.ts` |
| Ollama vision call | `src/ollama.ts` (`analyzeFrame`) |
| Ollama/ffmpeg error → fix-and-resume message | `src/resumable-error.ts` (`classifyOllamaError`) |
| caption arg parsing / SVG-HTML assembly | `tools/caption-format.mjs` |
| caption Chromium render pipeline | `tools/render-caption.mjs` |
| editor-handoff export (segments/overlays/audio/manifest/rebuild) | `tools/export-project.mjs` (I/O) + `tools/export-manifest.mjs` + `tools/fcpxml.mjs` (pure) |
| FCP transitions in the .fcpxml (+ segment handles) | `manifest.transitions` → `buildFcpxml` (`TRANSITION_UIDS`) + handle baking in `buildManifest`/`segmentArgs`/`rebuildScript` (all pure, `tools/{fcpxml,export-manifest}.mjs`); opt-in via cut-spec `transitions` |
| multi-cam angle cut → editor-handoff cut spec | `expandMulticamGroup` in `tools/multicam.mjs`; the `audioTrack` + drift `rateCorrection` flow through `export-manifest.mjs` + `fcpxml.mjs` |
| multi-cam true FCPXML mc-clip asset | `buildMulticamFcpxml` in `tools/fcpxml.mjs` (pure) + `tools/export-multicam-fcpxml.mjs` (I/O) |
| multi-cam flat preview MP4 (compare vs FCP) | `tools/render-multicam-preview.mjs` (ffmpeg I/O) over `resolveAngleCuts` in `tools/multicam.mjs` (pure) |
| multiple-source input → sources.json | `tools/analyze-sources.mjs` (I/O) + `tools/sources.mjs` (pure) |
| multi-cam audio sync → multicam.json | `tools/sync-multicam.mjs` (I/O) + `tools/multicam-dsp.mjs` (pure DSP: FFT cross-correlation, confidence, drift) + `tools/multicam.mjs` (pure: group manifest, angle cuts) |
| multi-cam group proposal from a pool | `tools/propose-groups.mjs` (I/O) + `tools/multicam-groups.mjs` (pure: folder / time-window / filename heuristics) |
| tool detection / brew install / skill install / launch | `bin/video-studio.mjs` |
| the editing pipeline Claude runs | `skills/video-studio/SKILL.md` |
| what the toolkit must do | `docs/requirements.md` |
| editor-handoff + multi-source feature specs (shipped) | `docs/editor-handoff.md`, `docs/multiple-sources.md` |
| FCP transition suggestions (shipped VS-28/50) | `docs/transitions.md` + `TRANSITION_UIDS`/handles in `tools/{fcpxml,export-manifest}.mjs` |
| render transitions into video without FCP (VS-54/55) | `docs/render-transitions.md` (R-RT) + `tools/transitions-render.mjs` (pure: recipe maps + full-chain/windowed plans + `windowedClipFilter`) + `tools/render-transitions.mjs` (ffmpeg I/O: windowed default, `--full-chain`) |
| multi-cam design + audio sync spec | `docs/multicam.md` (design) + `docs/multicam-sync.md` (sync tool, shipped) |
| auto multi-cam cutting / "edit awareness" | `docs/audio-events.md` (R-AE, shipped) + `docs/visual-saliency.md` (R-VS, shipped) + `docs/multicam-auto-cut.md` (R-AC, shipped VS-46 model + VS-47 integration + VS-62 shot-length policy/long-take exception; BYAM demo run) |
| auto angle-switch selection → switches.json → exporters | `tools/propose-switches.mjs` (I/O CLI, prints rationale) + `tools/multicam-autocut.mjs` (pure: weighted scoring + constraint smoothing + shot-length policy w/ instrumental long-take exception + per-switch review signal + `evaluate()` metrics, VS-46/62/63); fed to `export-multicam-fcpxml`/`render-multicam-preview` via `--switches` (glue: `switchesFromDoc` in `multicam.mjs`, VS-47) |
| review low-confidence auto-cuts in a browser | `tools/review-switches.mjs` (local server + page + ffmpeg ±2s previews, I/O) over `tools/review-model.mjs` (pure: flagged segments, candidate angles, apply-choice + history, VS-65); writes picks back to `switches.json` + `switches.history.json` (`docs/multicam-review-ui.md`, R-RUI) |
| is every documented requirement tested? (feature coverage) | `docs/feature-coverage.md` (R7.5/R-EC) + `tools/requirement-coverage.mjs` (pure: index + manifest + audit) + `tools/check-features.mjs` (report/gate) + `tests/conventions.test.ts` |
| non-speech audio-events pass → audio-events.json | `tools/analyze-audio-events.mjs` (ffmpeg I/O) + `tools/audio-events.mjs` (pure: envelope/onsets/sectioning + spectral descriptors/structural novelty, VS-44/49) |
| per-angle visual saliency → saliency.json | `tools/analyze-visual-saliency.mjs` (ffmpeg motion pass + gated Ollama vision, I/O) + `tools/visual-saliency.mjs` (pure: windowing, group-clock map, motion norm, vision-reply parse, gating, schema, VS-45) |
| FCP-incompatible WAV audio detection + opt-in normalize | `docs/fcp-audio-compat.md` (R-FA) + `tools/wav-compat.mjs` (pure) + `tools/wav-compat-io.mjs` (I/O warn / `--fcp-normalize-audio` re-encode), wired into `sync-multicam`/`export-multicam-fcpxml` (VS-40/53) |
| how to release | `docs/releasing.md` + `scripts/release.sh` |
| manual pipeline tests | `docs/manual-test-plan.md` |
| README demo media + how it's regenerated | `docs/media/` + `scripts/gen-readme-media.sh` |
| sample scene descriptions / transcript | `docs/samples/` + `scripts/gen-readme-samples.sh` |

## Update triggers

Update this file in the same change when you: add/remove a file or directory;
add a bin/entry point; change the analyzer state or timeline shape; add a CLI
flag; add or move a doc; change a build/test/lint command or coverage config;
or change a tuning constant.

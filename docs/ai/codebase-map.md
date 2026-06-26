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
│   └── caption-format.mjs      # pure arg-parse + SVG/HTML assembly (unit-tested)
├── skills/
│   └── video-studio/SKILL.md   # the pipeline Claude follows — primary interface
├── tests/
│   ├── scene-math.test.ts      # unit tests for src/scene-math.ts
│   ├── analyzer-cli.test.ts    # unit tests for src/analyzer-cli.ts
│   ├── analyzer-state.test.ts  # unit tests for src/analyzer-state.ts
│   ├── resumable-error.test.ts # unit tests for src/resumable-error.ts
│   ├── caption-format.test.ts  # unit tests for tools/caption-format.mjs
│   └── packaging.test.ts       # guards machine-path leaks + the promo-assets packaging
├── promo-assets/               # worked-example assembly scripts (sources shipped via promo-assets/*.{mjs,sh}; generated SVGs + nested node_modules excluded)
├── docs/
│   ├── requirements.md         # source-of-truth requirements (shipped pipeline)
│   ├── editor-handoff.md       # DESIGN: export segments + overlays + manifest/FCPXML (VS-20/21)
│   ├── multiple-sources.md     # DESIGN: draw from many files/folders (VS-18)
│   ├── multicam.md             # DESIGN: audio-synced multi-cam (VS-19, deferred)
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
| Everything | `npm run check` (lint → typecheck → test → build) |
| Run launcher | `npm run studio` · doctor `npm run doctor` |

Coverage is enforced (100% l/b/f/s) on the pure modules in `vitest.config.ts`
`coverage.include`: `src/scene-math.ts`, `src/resumable-error.ts`,
`src/analyzer-cli.ts`, `src/analyzer-state.ts`, `tools/caption-format.mjs`. The
I/O code (`analyzer.ts` orchestration, `ffmpeg.ts`, `ollama.ts`, the `bin/`
launcher, `render-caption.mjs`'s Chromium path) is manual-test territory.

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
  (`src/scene-math.ts`).

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
| tool detection / brew install / skill install / launch | `bin/video-studio.mjs` |
| the editing pipeline Claude runs | `skills/video-studio/SKILL.md` |
| what the toolkit must do | `docs/requirements.md` |
| design-only feature specs (export/FCPXML, multi-source, multi-cam) | `docs/editor-handoff.md`, `docs/multiple-sources.md`, `docs/multicam.md` |
| how to release | `docs/releasing.md` + `scripts/release.sh` |
| manual pipeline tests | `docs/manual-test-plan.md` |
| README demo media + how it's regenerated | `docs/media/` + `scripts/gen-readme-media.sh` |
| sample scene descriptions / transcript | `docs/samples/` + `scripts/gen-readme-samples.sh` |

## Update triggers

Update this file in the same change when you: add/remove a file or directory;
add a bin/entry point; change the analyzer state or timeline shape; add a CLI
flag; add or move a doc; change a build/test/lint command or coverage config;
or change a tuning constant.

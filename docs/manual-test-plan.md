# Manual Test Plan

video-studio's core is a pipeline over **external tools** — ffmpeg/ffprobe, whisper,
Ollama, and a headless Chromium (via Playwright/domotion-svg). That orchestration
can't be exercised by fast, deterministic unit tests, so it lives here as a manual
checklist. Run it before a release, or after touching the analyzer, the launcher,
or the caption renderer.

The pure logic *underneath* the pipeline (fps/timecode/scene math, caption
argument + SVG assembly) **is** unit-tested — see
[`tests/`](../tests) and the "Automated Coverage Summary" at the bottom. Don't
re-test those by hand; this doc is only for what crosses a process/tool boundary.

## Prerequisites

- macOS with Homebrew.
- `node >= 18`, `npm install` + `npm run build` done in the repo.
- Tools installed (or let the launcher offer to install them):
  `ffmpeg`, `ffprobe`, `whisper` (`openai-whisper`), optionally `ollama`, and `claude`.
- A sample input video (a 1–10 min screen-recording or talk works well).

## 1. Launcher / doctor (`bin/video-studio.mjs`)

| # | Step | Expected |
|---|------|----------|
| 1.1 | `node bin/video-studio.mjs --check` | Prints the splash + a per-tool pass/fail table. Exits without installing or launching. Reports "All set." when everything is present, or "Some required tools are missing." otherwise. |
| 1.2 | `node bin/video-studio.mjs --check` with a required tool removed from PATH | That tool shows as missing with its `brew install …` / manual hint; exit message flags the missing required tool. |
| 1.3 | `node bin/video-studio.mjs --help` | Prints the splash and the usage block (lines parsed from the file header). |
| 1.4 | `node bin/video-studio.mjs --skills-only` | Copies `skills/*` into `~/.claude/skills/`, substitutes `{{TOOLKIT_DIR}}` in each `SKILL.md`, prints one `/name → …` line per skill, exits. |
| 1.5 | `node bin/video-studio.mjs --no-launch <dir>` | Runs tool checks + `npm install`/build + installs skills, prints "Ready", but does **not** start `claude`. |
| 1.6 | On a non-macOS host (or simulate) | Exits early with "video-studio currently supports macOS only." |
| 1.7 | `node bin/video-studio.mjs <dir>` in a real terminal | After the "Ready" how-to, it **pauses on "Press Enter to launch Claude…"** so the how-to is readable; Claude launches only after Enter. With `--yes`, or when stdin isn't a TTY, it skips the pause. (VS-22) |

## 2. Scene analyzer (`dist/analyzer.js`)

| # | Step | Expected |
|---|------|----------|
| 2.1 | `node dist/analyzer.js <video> /tmp/vs-data --out /tmp/scenes.json` | Detects scene boundaries, extracts one frame per scene into `/tmp/vs-data/frames/`, writes `timeline.json` + `/tmp/scenes.json`. Each record has `start`/`end` as `HH:MM:SS:FF`, `startFrame`/`endFrame`/`startSeconds`/`endSeconds`, a `framePath`, and a blank `description`. |
| 2.2 | Re-run the exact same command | Resumes: prints "Resuming: N scene(s) already detected…", does **not** re-decode. Frames already on disk are not re-extracted. |
| 2.3 | Re-run after editing/replacing the video file | Prints "Existing state is for a different video…", starts fresh. |
| 2.4 | Spot-check `framePath` images against the timecodes | The representative frame for each scene is drawn from roughly the middle of that scene and matches the `start`/`end` range. |
| 2.5 | `--describe ollama` with the Ollama app **not** running | Stops with the "Could not reach the Ollama server" resumable error and start-it instructions; progress is saved. |
| 2.6 | `--describe ollama --model <missing>` | Stops with the "model is not available" resumable error and an `ollama pull` hint. |
| 2.7 | `--describe ollama` with Ollama running + model pulled | Fills each record's `description`; re-running resumes mid-list without redescribing done scenes. |
| 2.8 | Run with `ffmpeg` removed from PATH | Stops with the "ffmpeg is not installed" resumable error. |

## 3. Caption / overlay renderer (`tools/render-caption.mjs`)

| # | Step | Expected |
|---|------|----------|
| 3.1 | `node tools/render-caption.mjs --text "Hello" --out /tmp/cap.svg` | Writes an animated SVG; prints `wrote … KB, …s @ 24fps, style=pill, pos=lower-third`. |
| 3.2 | `--style cta --text "Watch the full demo →" --text "{{URL}}" --out /tmp/cta.svg` | CTA pill + monospace subline render; placeholder text preserved verbatim. |
| 3.3 | `--style plain` / `--position center` / `--position upper-third` | Output reflects the chosen style/position. |
| 3.4 | `--icon <some.svg>` (pill or cta) | Icon is embedded as a base64 data-URI with namespaced ids (no id collisions when two icons share names). |
| 3.5 | Render to alpha video: `node_modules/.bin/svg-to-video /tmp/cap.svg -o /tmp/cap.mov --format prores --background transparent --fps 24` | Produces a transparent ProRes 4444 `.mov`; overlaying it onto footage shows the caption with correct alpha and no fade-mid-hold flicker. |
| 3.6 | `--help` | Prints the usage block; exits 0. |
| 3.7 | No `--text` / no `--out` / unknown flag | Prints the specific error and exits 2. |

## 4. End-to-end promo build

Drive the full skill flow (analyze → whisper soundbite timing → design cut →
caption overlays → ffmpeg composite → verify) on a real video — see
[`skills/video-studio/SKILL.md`](../skills/video-studio/SKILL.md) and the worked
example in `promo-assets/`.

| # | Step | Expected |
|---|------|----------|
| 4.1 | Build a ~15s teaser | A finished `.mp4` next to the source; first 3s hook present; soundbite audio synced; B-roll silent (≈ -91 dB). |
| 4.2 | Sample one frame per segment and view them | Overlays composited, framing correct, captions legible. |
| 4.3 | Re-whisper the soundbite segments | Words are clean and complete — no clipped first/last word. |
| 4.4 | 9:16 social variant | 1080×1920 output; talking-head framing survives the crop. |

## 5. Editor handoff export (`tools/export-project.mjs`)

Write a cut spec (see [`editor-handoff.md`](editor-handoff.md)) referencing real source clips + a rendered alpha overlay, then:

| # | Step | Expected |
|---|------|----------|
| 5.1 | `node tools/export-project.mjs cut.json --out out/` | Creates `out/segments/seg-NNN.mov` (ProRes 422 HQ, `yuv422p10le`), `out/overlays/ov-NNN.mov` (ProRes 4444, alpha), `out/manifest.json`, and an executable `out/rebuild.sh`. |
| 5.2 | Inspect `manifest.json` | Segments in cut order with cumulative target ranges (`HH:MM:SS:FF` + seconds + frames) + source file/in/out + audio keep/silent; overlays with target range, position, and over-segment ref; project total matches. |
| 5.3 | Probe a segment / overlay codec | Segment is `prores` `yuv422p10le`; overlay is `prores` profile 4444 with an alpha pixel format. |
| 5.4 | `bash out/rebuild.sh rebuilt.mov` | Re-composites the exact cut — duration equals `manifest.project.totalTimecode`; frame-sampling shows overlays composited at their target times. |
| 5.5 | Import the segments/overlays (or the rebuilt cut) into Final Cut Pro | Clips conform at the project fps; overlays carry transparency. |

## Automated Coverage Summary

Covered by unit tests (do **not** re-test by hand):

- **`src/scene-math.ts`** — `parseFps`, `buildScenes`, `formatTimecode`
  (`tests/scene-math.test.ts`). 100% coverage.
- **`src/analyzer-cli.ts`** — `parseArgs` flag handling + validation exits
  (`tests/analyzer-cli.test.ts`). 100% coverage. (The §1.3 `--help` and the
  invalid-flag rows above are now unit-covered for the *analyzer* CLI; the
  launcher's `--help` is still manual.)
- **`src/analyzer-state.ts`** — `loadState` / `saveState` round-trip, version +
  corrupt-file handling, `stateMatchesVideo` (`tests/analyzer-state.test.ts`).
  100% coverage — so the §2.2/§2.3 *resume vs. start-fresh decision logic* is
  unit-covered; the end-to-end ffmpeg resume in those rows is still manual.
- **`src/resumable-error.ts`** — `classifyOllamaError` connection/model/generic
  branches (`tests/resumable-error.test.ts`). 100% coverage — the §2.5/§2.6
  error *classification* is unit-covered; the rows stay to verify the real
  Ollama failure actually triggers them.
- **`tools/caption-format.mjs`** — `parseArgs`, `namespaceSvgIds`, `iconImg`,
  `block`, `wrapPos`, `buildPage`, `buildSpecs` (`tests/caption-format.test.ts`).
  100% coverage.
- **`tools/export-manifest.mjs`** — `buildManifest`, `framesToTimecode`,
  `segmentArgs`, `overlayArgs`, `rebuildScript` (`tests/export-manifest.test.ts`).
  100% coverage. The ffmpeg execution in `export-project.mjs` is §5 above.

Everything else in the tables above is genuinely manual because it shells out to
ffmpeg/whisper/ollama or launches a browser. If you find a way to automate one of
these items, move it into `tests/`, delete the row here, and add it to this list.

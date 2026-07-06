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
| 1.5 | `node bin/video-studio.mjs --no-launch <dir>` | Runs tool checks + the analyzer prep + installs skills, prints "Ready", but does **not** start `claude`. |
| 1.6 | On a non-macOS host (or simulate) | Exits early with "video-studio currently supports macOS only." |
| 1.7 | `node bin/video-studio.mjs <dir>` in a real terminal | After the "Ready" how-to, it **pauses on "Press Enter to launch Claude…"** so the how-to is readable; Claude launches only after Enter. With `--yes`, or when stdin isn't a TTY, it skips the pause. (VS-22) |
| 1.8 | **Global/npx install** — `npm i -g video-studio && video-studio --no-launch <dir>` (or from the packed tarball) | Under "Preparing analyzer" it prints **"analyzer ready (dist/analyzer.js)"** and does **NOT** run `npm run build` / `tsc` — the prebuilt `dist/` ships in the package and consumers lack the TS devDependencies. **No `tsc` type-error wall** (the VS-77 regression). The build only runs in a dev checkout (toolchain present) or when `dist/` is absent — decided by the pure `analyzerPrepPlan` in `tools/launcher-plan.mjs`. |

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
| 5.5 | Import `<name>.fcpxml` into Final Cut Pro | Segments land on the primary storyline in order at their target ranges; overlays appear as connected clips (lane 1) above their segments; clips conform at the project fps with no warnings; overlays carry transparency. |
| 5.6 | Add a `transitions` block to the cut spec (e.g. `[{ "afterClip": 0, "name": "Cross Dissolve", "durationSeconds": 1 }, { "afterClip": 2, "name": "Fade To Color", "durationSeconds": 0.6 }]`), re-export, import the `.fcpxml` into FCP (docs/transitions.md) | The named cuts show the chosen transition centered on the cut (Cross Dissolve / Fade To Color), tweakable/deletable; unlisted cuts stay hard. The flanking segments have handle media (the export reports the handle seconds; segment files are longer than their slot). `rebuild.sh` still reproduces the **exact** flat cut (handles trimmed via concat inpoint/outpoint). The generated `.fcpxml` validates against FCP's bundled `FCPXMLv1_10.dtd` (see docs/multicam.md for the xmllint command). |

## 6. Multiple-source input (`tools/analyze-sources.mjs`)

| # | Step | Expected |
|---|------|----------|
| 6.1 | `node tools/analyze-sources.mjs <folder-with-mixed-clips> --data-dir /tmp/vs --out /tmp/sources.json` | Recurses the folder, picks up only video files (ignores `.txt`/`.svg`/etc.), analyzes each into `/tmp/vs/<id>/`, and writes `sources.json`. |
| 6.2 | Pass a **mix** of explicit files and folders, with a duplicate path | The duplicate is de-duped; each source gets a stable slug id (`Interview Take 1.mp4` → `interview-take-1`); colliding names disambiguate (`clip`, `clip-2`). |
| 6.3 | Inspect `sources.json` | `sources[]` lists each id/path/fps/width/height/duration/sceneCount (fps may differ between sources); `scenes[]` is the union, each tagged with `sourceId` + source-relative timecodes. |
| 6.4 | Re-run the same command | Per-source analysis **resumes** (the analyzer caches per file); already-extracted frames aren't redone. |
| 6.5 | Build a cut spec drawing clips from two different sources → `export-project` | Segments extract from the correct source files; the export conforms them to the one project fps/size. |

## 7. Multi-cam audio sync (`tools/sync-multicam.mjs`)

The FFT/manifest math is unit-tested (`tools/multicam.mjs`, 100%); these rows
exercise the ffmpeg mono extraction + the real end-to-end sync.

| # | Step | Expected |
|---|------|----------|
| 7.1 | Take one clip, make a second from it offset by a known amount (`ffmpeg -ss 2 -i a.wav b.wav`), then `node tools/sync-multicam.mjs a.wav b.wav --out /tmp/multicam.json` | `multicam.json` has one group; the second member's `offsetSeconds` matches the known offset (±a few ms), `sync: "auto"`, `confidence` near 1. |
| 7.2 | Include an **audio-only** file (e.g. a `.wav` recorder track) among camera clips | The audio-only member is the `referenceId` **and** `masterAudioId` (offset 0); cameras sync to it. |
| 7.3 | Include a clip with **unrelated / silent** audio | It comes back `sync: "unsynced"` with low confidence and a `--manual <id>=<sec>` re-run hint; re-running with `--manual` sets that offset and labels it `manual`. |
| 7.4 | Mix members with **different fps** (e.g. 29.97 and 30) | Sync still succeeds (alignment is seconds-based); `projectFps` defaults to the highest member fps; each member keeps its own `fps`. |
| 7.5 | Sync a **long take** (> `--drift-min`, default 600 s) with a growing clock offset (e.g. an `atempo=1.001` copy of a structured signal) | The drifting member reports a `driftPpm` near the true rate, past 100 ppm `driftWarning: true`, plus a `rateCorrection` (≈ 1 + ppm/1e6) and a start-anchored `correctedOffsetSeconds`. A non-drifting copy reports ~0 ppm. (Applying the retime on export is VS-29.) |
| 7.6 | Re-run 7.1 with `--feature phat` (and with `--no-interpolate`) | `phat` (GCC-PHAT) still recovers the offset, typically with a sharper/higher `confidence`; `--no-interpolate` yields whole-sample `offsetSeconds`, otherwise it is sub-sample-refined. |
| 7.7 | `node tools/propose-groups.mjs <sources.json>` over a pool with two clips in one folder + one elsewhere | Proposes the folder/overlap group (>=2 members) with a ready-to-run `sync-multicam` command; `--strategy filename`/`--json` switch the heuristic/format. Singletons are never proposed. |
| 7.8 | From a synced `multicam.json`, build a cut spec with `expandMulticamGroup(group, switches, {name,width,height})`, run `export-project`, then `rebuild.sh` | The rebuilt cut has **continuous master audio** under **switching video angles** (e.g. frame colors change at each switch point); the export folder has `audio/master.mov`; the `.fcpxml` is well-formed with the master audio on a connected `lane="-1"` clip. |
| 7.9 | `node tools/export-multicam-fcpxml.mjs <multicam.json> --width <w> --height <h> --switch 0=<id> --switch <t>=<id2>` then **import the `.fcpxml` into Final Cut Pro**. A ready-made fixture lives at `external/multi-cam/BYAM-multicam.fcpxml` (4 synced 23.976 fps cameras + a master WAV, 32 angle switches over the BYAM music video; regenerate with `node external/multi-cam/build.mjs`) (VS-36). | FCP builds a **live multicam clip**: one angle per member synced at its offset, **audible master audio in sync with the picture** (every mc-clip selects audio from the master-audio angle via `<mc-source srcEnable="audio">`, and each camera angle's leading gap is filled with real black video — the generated `<name>.black.mp4` sidecar — so the multicam has frames from time 0 and FCP doesn't clamp the audio's head-start late, VS-36), and the spine cuts between the chosen angles at the switch points. You can open the angle viewer and re-cut angles. **This real-FCP round-trip is the validation that the multicam FCPXML is correct** — automated tests only check the XML structure; file a bug if FCP rejects any element. |
| 7.10 | Export a **drifting** member's angle cut (long take, non-zero `driftPpm`) via 7.8 | The drifting angle's segment is `setpts`-retimed so it still fills its timeline slot (no progressive slip vs the master audio); its manifest segment carries `rateCorrection` and a slot-length `durationSeconds`. |
| 7.11 | `node tools/render-multicam-preview.mjs <multicam.json> --switch 0=<id> --switch <t>=<id2> [--start <sec>] [--width <w> --height <h>] --out preview.mp4`, then play it (the BYAM fixture is `external/multi-cam/BYAM-multicam-preview.mp4`) | A flat MP4 of the **same** angle cut as the §7.9 FCPXML: video cuts between the synced angles at the switch points, the master audio plays continuously underneath, and a chosen angle with no footage yet at a cut shows **black** until its camera rolled. `--start` trims leading dead air (re-bases the timeline + audio to that group time), matching the FCPXML `--start`. Use it to eyeball the edit and sanity-check sync without FCP. |
| 7.12 | Export with `--start <sec>` (e.g. the latest member offset), then import into FCP | The edit begins on live footage (no black head) and stays in sync. `--start` is purely a convenience trim — audio stays locked regardless (it rides the master-audio angle); use it to drop the leading black/dead-air, not to fix sync. The flat preview (§7.11) with the same `--start` matches the FCP playback. |

## 8. Non-speech audio-events pass (`tools/analyze-audio-events.mjs`)

| # | Action | Expected |
|---|--------|----------|
| 8.1 | `node tools/analyze-audio-events.mjs <audio-or-video> --out audio-events.json` | Writes `audio-events.json` (docs/audio-events.md schema): a versioned doc with a `source`, a coarse `envelope.rmsDb` (one value per hop), and sorted `events` — `quiet`/`instrumental`/`vocal` content sections, `onset` accents, **and Tier-2 structural `section` events**. Without `--transcript`, energetic non-quiet spans are all `instrumental` (no vocal split). On the BYAM master: a quiet intro/outro, one instrumental body, ~629 onsets, **~19 structural `section` events**. |
| 8.2 | Re-run with `--transcript <whisper.json>` (whisper `--word_timestamps` JSON; `--offset` if the transcript is clip-relative) | The instrumental body is split into `vocal` sections (where words fall, merged within ~1.5 s and padded) and `instrumental` sections (energetic, no words — the riff). Each `vocal` event carries `data.wordCount`. |
| 8.3 | `--quiet-db`, `--hop`, `--min-span`, `--sample-rate` knobs | Adjust the quiet floor, envelope resolution, minimum section length, and analysis rate respectively; output stays well-formed and sorted by `startSeconds`. |
| 8.4 | **Tier-2 spectral check** — inspect each section's `data.spectral` | Every content/structural `section` whose span contains an FFT window carries `data.spectral` with `centroidHz`, `rolloffHz`, `zcr`, `flux`, and `bands` (`[low, mid, high]` summing to ~1). On the BYAM master, structural-section centroids span ~1.3–2.3 kHz. |
| 8.5 | **Tier-2 brightness check (needs a transcript)** — generate a word-timestamp transcript for the master, then run 8.2 and compare `data.spectral.centroidHz`/`bands[2]` of the **instrumental (riff)** sections vs the **vocal** sections | Instrumental spans read **at least as bright** as vocal spans (higher/equal centroid + high-band fraction). See the **VS-51 finding** below — on the full-band BYAM mix the separation is real but **marginal**. |

**Generating the transcript** (`external/` is gitignored, so the transcript is a local regenerable fixture, not committed):

```
cd external/multi-cam
whisper BYAM-audio-clean.wav --model large-v3-turbo --word_timestamps True \
  --output_format json --output_dir . --language en --fp16 False
mv BYAM-audio-clean.json BYAM-audio-clean.transcript.json
node ../../tools/analyze-audio-events.mjs BYAM-audio-clean.wav \
  --transcript BYAM-audio-clean.transcript.json --out audio-events.json
```

**VS-51 finding (recorded 2026-06-30, duration-weighted means over the BYAM master):**

| Section kind | n | total dur | mean centroid | mean high-band | mean rolloff |
|---|---|---|---|---|---|
| instrumental (riff) | 20 | 84.2 s | **1723 Hz** | **0.073** | 3691 Hz |
| vocal (sung) | 21 | 145.9 s | 1721 Hz | 0.071 | 3615 Hz |

Direction is as expected (instrumental brighter) but the margin is **tiny** (+2 Hz
centroid, +0.002 high-band). The master is a **full-band mix** — the band keeps
playing under the vocals, and the whisper gate splits spans by *lyrics present*,
not by isolating a vocal stem, so the two groups' spectra are nearly identical.
**Implication:** energy+spectral heuristics on the mixed master give only a weak
"riff vs voice" timbre separation — this is exactly the evidence
[`fcp`/stem-separation gate](audio-events.md) **VS-48** (Demucs) was waiting on. If
the angle selector (VS-46) needs robust instrument/vocal brightness, stems are the
way; the per-window descriptors themselves are correct and discriminate strongly
on single-source tones (8.4 / `tests/audio-events.test.ts`).

## 9. FCP-incompatible source audio: warn + opt-in normalize (`tools/wav-compat-io.mjs`, VS-40/53)

The pure detection + path/argv helpers (`tools/wav-compat.mjs`) are unit-tested;
this exercises the real-file warning and the `ffmpeg` re-encode (`ensureFcpCompatAudio`)
wired into `sync-multicam` / `export-multicam-fcpxml`. See
[`fcp-audio-compat.md`](fcp-audio-compat.md).

| # | Action | Expected |
|---|--------|----------|
| 9.1 | `node tools/sync-multicam.mjs "external/multi-cam/BYAM-audio.wav" "external/multi-cam/BYAM cam 1.mp4" …` (the **raw** Pro Tools / BWF WAV) | A stderr **WARNING** that the audio "may not import into Final Cut Pro", naming the non-canonical 40-byte `fmt ` chunk + the `junk, bext, minf, elm1` metadata chunks, the silent-import symptom, and the `ffmpeg -fflags +bitexact … -map_metadata -1 …` fix. The sync still completes normally. |
| 9.2 | Re-run 9.1 with the **clean** WAV (`BYAM-audio-clean.wav`) | **No** warning (canonical 16-byte `fmt `, no metadata chunks). |
| 9.3 | `node tools/export-multicam-fcpxml.mjs multicam.json` where the group's audio member is a BWF WAV | The same warning prints before the FCPXML is written; camera `.mp4`/`.mov` members never trigger it. |
| 9.4 | Re-run 9.1 / 9.3 with **`--fcp-normalize-audio`** (VS-53) | The toolkit re-encodes the BWF WAV to a canonical **`<name>.fcp.wav`** sidecar next to the source (`Normalized … → ….fcp.wav`) and repoints the manifest / FCPXML asset at it. The sidecar parses as `fmt (16)` + `data` (canonical PCM) and no longer warns. |
| 9.5 | Run 9.4 a **second time** (sidecar already present + up to date) | The sidecar is **reused** (`Using existing FCP-safe WAV …`), no re-encode. Touch/delete the sidecar (or modify the source) to force a fresh re-encode. |
| 9.6 | Import the FCPXML (built with `--fcp-normalize-audio`) into Final Cut Pro | The master audio imports **with sound** — the VS-36 silent-import case is resolved without a manual `ffmpeg` step. |

## 10. Render transitions into video without FCP (`tools/render-transitions.mjs`, VS-54/55)

The pure plans + recipe maps + `filter_complex` (`tools/transitions-render.mjs`)
are unit-tested; this exercises the real ffmpeg render. See
[`transitions.md`](transitions.md) §8 and [`render-transitions.md`](render-transitions.md).

| # | Action | Expected |
|---|--------|----------|
| 10.1 | Export a cut with `transitions` (so segments carry handles), then `node tools/render-transitions.mjs <export>/manifest.json` | Writes `<name>.transitions.mov` (`Wrote … (windowed): … N segment(s), H hard cut(s), tiers {…}`). Plays the cut dissolving/wiping/sliding through each transitioned cut. |
| 10.2 | Count the output's video frames (`ffprobe -count_frames`) | Equals the **visible** timeline length in frames (handles absorb the transitions; visible content is not shortened). On the synthetic 3-clip/2-transition check (0.4 s each): 90 frames @ 30 fps and a mid-dissolve frame is a genuine A→B colour blend. (The container *duration* may read marginally long under the windowed renderer — a ProRes stream-copy artifact; `--full-chain` is sample-exact.) |
| 10.3 | Render a multicam flat export (manifest has an `audioTrack`, video-only segments) | Video transitions through the angle cuts while the **continuous master audio** is muxed under it unchanged (no `acrossfade`); video-only segments are handled. |
| 10.4 | A transition longer than the available handle, or a cut with no handle on a side | The transition is clamped to ≤ 2×handle, or the cut degrades to a clean hard cut — no error, no lost frames. |
| 10.5 | **Windowed vs `--full-chain` on a long cut** — render the same manifest both ways and time them (`time node tools/render-transitions.mjs … [--full-chain]`) | Both produce the same visible cut. The **windowed** default is much faster on a long cut with few transitions (re-encodes only the overlaps); `--full-chain` re-encodes the whole timeline. |
| 10.6 | **Native Tier B/C** — export with `Chevron`, `Static`, `Circle Inset`, `Rectangle Inset`, `Shapes Inset`, `Side-by-Side Split`, `Top & Bottom Split` and render (default windowed) | Each renders its native look — chevron-edged wipe; static-noise dissolve; a growing circle/rectangle/**diamond** (Shapes Inset, VS-57) revealing the incoming clip with a **soft feathered edge** (not a hard step); the outgoing clip's halves sliding apart. The run reports `tiers {"A":…,"B":…,"C":…}`. With `--full-chain` they degrade to the nearest Tier-A `xfade`. |

## 11. Per-angle visual saliency (`tools/analyze-visual-saliency.mjs`, VS-45)

The pure windowing / motion-normalization / vision-reply parsing / gating / schema
(`tools/visual-saliency.mjs`) are unit-tested; this exercises the ffmpeg motion pass
and the Ollama vision calls. See [`visual-saliency.md`](visual-saliency.md). Needs a
synced `multicam.json` (the BYAM group) + a running Ollama with a vision model.

| # | Action | Expected |
|---|--------|----------|
| 11.1 | `node tools/analyze-visual-saliency.mjs external/multi-cam/multicam.json --mode motion --window 2` | Writes `saliency.json`: `version`, `groupId`, `windowSeconds`, and per-angle window arrays on the group clock. Each window has `scores` (motion populated), `saliency`, `confidence`, `source:"motion"`. Windows before an angle's footage rolls are omitted (group→media mapping). Fast (no model). |
| 11.2 | Run with `--mode vision --audio-events external/multi-cam/BYAM-audio-events.json --cap 60` | Windows near a section boundary / with high motion get `source:"vision"` with model `scores` + `labels`; the rest stay motion-only. The run logs the vision-vs-motion split per angle and the total (no silent truncation). |
| 11.2a | Watch stderr during 11.2 in a terminal | A single line updates in place per angle: `[i/N] <angle>  vision k/X  avg Ns/call  eta ~Nm`. It advances after every vision call (not just once per angle) so a long run shows continuous progress + an ETA. `saliency.json` and the stdout summary are unchanged (progress is stderr-only). |
| 11.2b | Re-run 11.2 piped to a file: `… --mode vision … 2> progress.log` | `progress.log` gets newline-terminated progress lines (first/last call and every 5th between) instead of the in-place redraw — readable in redirected/CI logs, no `\r` clutter. |
| 11.3 | Inspect the BYAM scores | The active singer's angle scores high `performer`/`presence` during vocal sections; the guitar angle scores `instrument` during the riff; static/empty angles score low. (Advisory — the selector VS-46 owns final weighting.) |
| 11.4 | `--mode grid` and a large `--cap` | Every covered window is vision-scored (slowest, most accurate); `--cap` still bounds the calls and the skipped count is logged. |

## 12. Auto multi-cam angle selection (`tools/propose-switches.mjs`, VS-46/47)

The selection model + metrics are unit-tested (`tools/multicam-autocut.mjs`, 100%)
and the `switches.json` → exporter glue (`switchesFromDoc`) is unit-tested
(`tools/multicam.mjs`); these rows exercise the CLI wiring + the **BYAM
demonstration** the ticket calls for (favor the guitar during riffs, the singer
during vocals), which needs the external BYAM media + a real audio-events/saliency
run. See [`multicam-auto-cut.md`](multicam-auto-cut.md) (R-AC) + [`multicam.md`](multicam.md) R-MC7.

| # | Action | Expected |
|---|--------|----------|
| 12.1 | With the BYAM group synced (`external/multi-cam/multicam.json`), its `audio-events.json` (§8) and `saliency.json` (§11), run `node tools/propose-switches.mjs external/multi-cam/multicam.json --audio-events <…>/audio-events.json --saliency <…>/saliency.json --eval` | Writes `switches.json` next to the input: a versioned doc with a `switches` list (`{ atSeconds, memberId }`, strictly increasing, first at the trim start) **and a parallel `rationale`** naming why each cut was made (`instrumental → <angle>`, `vocals → active singer <angle>`, or `highest saliency → …`). stdout prints the same rationale + a ready-to-run `export-multicam-fcpxml … --switches …` line. |
| 12.2 | **BYAM editorial check** (the maintainer's flags) — inspect the rationale + `--eval` metrics, and compare the cut against the hand-built `external/multi-cam/BYAM-multicam-preview.mp4` | During the **riff/instrumental** sections the on-screen angle is the **guitar**; during **vocals** it's the **active singer** (not the idle person). `evaluate()` reports `instrumentalOnInstrumentAngle` and `vocalOnSingingAngle` **high (target ≳ 0.7)**, shot lengths within `[minShot, maxShot]`, and a switch count in the same ballpark as the hand edit (not wildly over/under-cut). Record the numbers here when run. |
| 12.3 | `node tools/render-multicam-preview.mjs external/multi-cam/multicam.json --switches <…>/switches.json --out preview.mp4` and play it | A flat MP4 whose angle cuts match `switches.json` (same as feeding the equivalent `--switch` flags); master audio continuous underneath. Eyeball it against §11.3's saliency and the hand edit. |
| 12.4 | `node tools/export-multicam-fcpxml.mjs external/multi-cam/multicam.json --width <w> --height <h> --switches <…>/switches.json --out byam-auto.fcpxml`, import into FCP | A live multicam clip cut at the proposed switch points (as §7.9, but auto-chosen). The console reports the loaded switch count. |
| 12.5 | **Override** — hand-edit `switches.json` (move/remove a cut), re-run 12.3/12.4 | The exporters honor the edited file verbatim; passing an explicit `--switch` flag alongside `--switches` makes the flags win (the file is ignored). |
| 12.6 | **Degraded paths** — run 12.1 with `--saliency` omitted, then with `--audio-events` omitted | No saliency → a footage-based round-robin (a `Note:` is logged); no audio-events → the riff/vocal priors + onset snapping are dropped (a `Note:` is logged). Neither crashes; both still produce a valid `switches.json`. |

## 13. Multi-cam review UI (`tools/review-switches.mjs`, VS-65)

The pure core (`tools/review-model.mjs` — which cuts to surface, candidate angles,
preview windows, apply-choice + history) is unit-tested to 100%. These rows exercise
the I/O shell: the local HTTP server, the browser page, ffmpeg preview extraction, the
in-place write-back, and the optional **re-propose** (re-run `autoCut` with the user's
picks as locks — the pure locks/variety model is unit-tested, VS-66). See
[`multicam-review-ui.md`](multicam-review-ui.md) (R-RUI).
Needs a synced group + a `switches.json` from §12 (whose `rationale` carries the R-AC9
`flagged` signal), plus ffmpeg and a browser.

| # | Action | Expected |
|---|--------|----------|
| 13.1 | `node tools/review-switches.mjs external/multi-cam/multicam.json --switches <…>/switches.json` | Logs how many **flagged** cuts it will review, extracts previews, starts `http://127.0.0.1:8777/`, and opens the browser. If no cuts are flagged: prints "No flagged cuts to review" and exits 0 (no server). |
| 13.2 | In the page | One section per flagged cut: the auto-picked angle + its confidence/why, a per-segment **transport** (Play/Pause + seek + time), and a row of **candidate angle clips** covering the cut **±2 s** (the auto pick tagged). Clips are **paused on load — nothing auto-plays**. Each clip card has **Pick / Audio / Full** buttons and there's an optional note field per cut. |
| 13.9 | **Playback (VS-71)** — click **Play** on one segment | All that segment's angle clips play **in sync** (scrub with the seek bar; they stay aligned), and the segment loops. Exactly **one** clip has audio (the pick by default); the section is marked active. |
| 13.10 | Click **Play** on a *different* segment | The previously-playing segment **pauses** — only one segment plays at a time, so you never hear two audios at once. |
| 13.11 | Click a clip's **Audio** button while playing | Audio moves to that clip (all others muted); visuals stay synced. Click **Full** on a clip | It goes **fullscreen** (and becomes the audio-focus clip). |
| 13.12 | Click **Pick** on a clip | That angle becomes the selected pick (card highlights, button reads "Picked"); Pick is independent of Audio/Full. Save/Re-propose then use the picked angle as in 13.3/13.7. |
| 13.13 | **Section marker (VS-72)** — inspect the scrubber | A highlighted **band** covers the section of interest (the shot the cut introduces, `[atSeconds, endSeconds]`) with a tick at the exact cut; the clip ends outside the band are the ±context lead-in/out. The segment header shows the section time range. As the playhead crosses the band you can see when you're in the actual shot vs context — so two overlapping neighbouring previews remain distinguishable. |
| 13.14 | **Whole-video timeline (VS-73)** — click **Load full-video preview** | A player + a full-width bar of angle-colored blocks (one per switch span) appear; flagged spans have an amber top border; a legend maps colors→angles. `/assembled` returns the full switch list; `/source/<id>` serves each angle with HTTP Range (206). |
| 13.15 | Click **Play** on the timeline | The whole assembled edit plays back; at each cut the visible/audible **angle switches** (a brief seek stall is expected — rough by design). The per-segment players pause (single audio). The playhead advances along the bar. |
| 13.16 | Click somewhere on the bar | Playback **scrubs** to that group time and shows the correct angle for that moment. Double-click the player → fullscreen. |
| 13.17 | Change a **Pick** in a per-segment card while the timeline is loaded | The bar **recolors** that span to the new angle immediately; if playing through that span, the visible angle **swaps live**. After a **Re-propose**, the timeline reloads to reflect the new switch list. |
| 13.18 | **Docked timeline (VS-74)** — click **Timeline** in the header | The timeline **expands as a drawer** from the fixed nav bar (first open lazy-loads it); click again to collapse. It stays reachable while scrolling the cards (no scroll-to-top). |
| 13.19 | **Add cut to review (VS-74)** — click a bar block for an **unflagged** cut, then **Add cut @ … to review** | The playhead lands in that block; the cut is appended as a review card tagged "(added for review)", even though it wasn't flagged. Its angle can then be changed + saved like any other. |
| 13.20 | **Split (VS-74)** — move the playhead mid-shot, click **Split here** | A new cut is inserted at the playhead, splitting the shot into two regions; a review card for the new (second) region appears (same angle initially). The timeline bar shows the new boundary. Choose a different angle for the second region. Splitting exactly on an existing cut is refused (status message). |
| 13.21 | After 13.19/13.20, click **Save** | `switches.json` reflects the added/split cuts and any angle changes; `switches.history.json` records a `{ split }` entry per split (and `{ from,to }` per angle change). A split with no angle change still persists the new cut (curSwitches changed). |
| 13.3 | Pick a different angle for one cut, add a note, click **Save** | The page shows the change count + the ready `export-multicam-fcpxml … --switches …` line. On disk: `switches.json` is rewritten in place with the new `memberId`, `switches.json.bak` holds the prior version, and `switches.history.json` gains an entry `{ atSeconds, from, to, at (ISO), note }`. |
| 13.4 | Re-run 13.1, click Save **without** changing anything | 0 changes; no `.bak` rewrite, no new history entry (only actual angle changes are recorded). |
| 13.5 | `--all` | Every cut is shown (not just flagged); `--port <n>` moves the server; `--context <s>` changes the preview lead/tail. |
| 13.6 | Feed the saved `switches.json` to §12.3 / §12.4 | The exporters honor the reviewed picks verbatim (it's the same hand-editable file). |
| 13.7 | **Re-propose (VS-67)** — run with `--audio-events <…> --saliency <…>` | A **Re-propose downstream** button appears (hidden without both inputs). Pick an angle for one cut, click it: the still-auto cuts re-flow around your pick (variety-aware, via `autoCut` locks), the page re-renders with the new flagged set, and your pick is preserved. Nothing is written yet. |
| 13.8 | After 13.7, click **Save** | Persists the re-proposed switches (`.bak` keeps the *original*, even across repeated saves) + a history entry `{ reproposedWithLocks: n }`. A second Save with no further change is a no-op. |

## 14. Desktop app — Node sidecar host (`desktop/sidecar/host.mjs`, VS-90)

The sidecar host's stdio plumbing + child-process spawning is the I/O edge; the protocol
framing + step registry it uses are unit-tested (see the Automated Coverage Summary). Run
from the repo root after `npm run build`.

| # | Action | Expect |
|---|--------|--------|
| 14.1 | `node desktop/sidecar/host.mjs` then type `{"type":"request","id":1,"step":"analyze-scenes","params":{"video":"<clip>.mp4"}}` + Enter | First line is `{"type":"ready"}`; then a stream of `{"type":"progress","id":1,"progress":{...}}` (stages `detect`/`detected`/`extract`/`describe`) as the analyzer runs; ends with `{"type":"result","id":1,...}`. |
| 14.2 | Send a request for an unknown step (`"step":"bogus"`) | A single `{"type":"error","id":...,"error":{"code":"unknown_step",...}}`; the host stays up for further requests. |
| 14.3 | Send a request missing a required param (`analyze-scenes` with no `video`) | `{"type":"error",...,"code":"missing_param",...}`. |
| 14.4 | Send a malformed line (`not json`) | `{"type":"error","id":null,"error":{"code":"malformed",...}}`; stream not poisoned — a following valid request still runs. |
| 14.5 | Start a long `analyze-scenes`, then send `{"type":"cancel","id":1}` | The child is killed; a terminal `{"type":"error",...,"message":"cancelled (SIGTERM)"}` for id 1. |
| 14.6 | Close stdin (Ctrl-D) mid-run | Any in-flight child is terminated and the host exits. |
| 14.7 | Send `{"type":"request","id":3,"step":"doctor"}` | A single `{"type":"result","id":3,"data":{"ready":...,"rows":[...]}}` — one row per tool (node/ffmpeg/ffprobe/whisper/ollama/claude) with `found` + `status` (`ok`/`missing-required`/`missing-optional`); `ready` true iff all required tools resolve. |
| 14.8 | In a folder containing `multicam.json` + `audio-events.json`, send `{"type":"request","id":4,"step":"project-open","params":{"folder":"<dir>"}}` | `result` with `data.project.artifacts` = `["audioEvents","multicam"]` (re-derived from disk) and `data.stages` showing new-project + analyze `done`, design `idle`, review/export `locked`. |
| 14.9 | `project-create` in an empty folder | Writes `.video-studio/project.json`; `result` snapshot has no artifacts and the rail shows only Setup active / New Project reachable. |
| 14.10 | `config-add-recent` then `config-add-rule` then `config-get` | Each returns the updated app config; the rule + recent project persist across requests (written under `~/Library/Application Support/video-studio/config.json`). `config-revoke-rule`/`config-reset-rules`/`config-set-policy` mutate + persist likewise; an unknown `config-*` step errors `unknown_step`. |

## 15. Desktop app window (`desktop/src-tauri`, VS-79/VS-90)

The native Tauri shell — GUI, not automatable here. Requires `cargo` + `node` on PATH.
Launch with `npm run desktop:dev` (= `cargo run --manifest-path desktop/src-tauri/Cargo.toml`).

| # | Action | Expect |
|---|--------|--------|
| 15.1 | `npm run desktop:dev` | The "Video Studio" window opens on the **Setup** screen; the left **stage rail** shows Setup + Analyze active, and New Project/Design/Review/Export **locked** (greyed, not clickable). |
| 15.2 | On Setup, click **Check tools** | A row per tool appears with a green dot (found) / red (missing required) / amber (missing optional) and, for missing ones, a plain-language install hint. Values match `bin/video-studio.mjs --check`. |
| 15.6 | Click **New Project**, then **Open project folder…**, choose a folder that already has pipeline artifacts | The project name + folder + an artifact chip list appear; the **stage rail lights up** — stages whose artifacts exist read `done`, the next reachable one is selectable, later ones stay `locked`. |
| 15.7 | **Create here…** in an empty folder | `.video-studio/project.json` is written; the rail shows Setup active + New Project reachable, the rest locked. |
| 15.8 | Click **Permissions** (rail footer), toggle "Access the network" on/off | A row per category with an allowed/asks state; toggling persists via `config-set-policy` (survives reopening the screen / relaunching). "Delete / write outside the project" is shown but locked (always asks). |
| 15.9 | With a remembered rule present, use **Revoke** on it and **Reset all** | Revoke removes that one rule; Reset all clears the list (the empty-state hint returns). Both persist to the config file. |
| 15.10 | Open a multi-cam project, go to **Export**, click **Export** on the MP4 card | Status → rendering… (live tool output) → done; `<project>/exports/cut.mp4` is written (`render-multicam-preview` over `multicam.json` + `switches.json` when present). 9:16 writes `cut.9x16.mp4` (1080×1920); FCPXML writes `cut.fcpxml` (fast, no render). |
| 15.11 | After an export completes, click **Reveal in Finder** | Finder opens with the output file selected (`open -R`). |
| 15.12 | Open a multi-cam project with a `switches.json`, click **Review** in the rail | The review UI loads **embedded in an iframe** (no separate browser window — `review-switches --no-open`), flagged cuts first, synced angle player + timeline. Picking/splitting + Save writes back to `switches.json`. Re-entering Review reuses the same server. A project with no cut shows a prompt instead. |
| 15.13 | **Design** stage: click a preset (e.g. Teaser) | The prompt box fills with the preset text. **Open the timeline** proposes an auto cut via `propose-switches` when there's none (status updates), refreshes the rail, and lands on Review; with an existing cut it jumps straight to Review. |
| 15.18 | (VS-96) **Design → Auto lane** on a multi-cam project: type a prompt (e.g. "punchy 15s highlight") → **Make my cut** | The activity feed streams the live agent run. When the agent ends its reply with a `{ switches: [...] }` cut plan, the host lands it as `switches.json` (version + the project's groupId) and the app opens **Review** on that cut ("The AI proposed your cut…"). If the agent doesn't produce a valid plan, it falls back to the deterministic `design-cut` baseline. Verified end-to-end against the logged-in Claude backend (agent's Bash attempt is blocked by our policy; the JSON cut plan is landed). Session resume + `allowedTools` pre-approval remain (VS-96 tail). |
| 15.15 | **New Project** → open a folder of camera angles (or a single video) → **Analyze this footage** | Detects single vs multi-cam: 2+ videos → `sync-multicam` writes `multicam.json` ("Synced N angles"); one video → `analyze-sources` writes `sources.json`. The rail then unlocks (New Project done → Analyze/Design reachable). An empty folder → "no video files found". |
| 15.17 | (VS-99) Single video: New Project → open a folder with ONE video → Analyze this footage → Analyze → Design → Manual "Open the timeline" (or Auto "Make my cut") | design-cut writes `cut.json` (a scene-range cut spec, not `switches.json`); the rail advances (Design ✓, Review ✓ — single-source needs no angle review) and lands on **Export**. Export MP4 flat-renders `cut.json` (ffmpeg trim+concat) → `exports/cut.mp4`; 9:16 pads to 1080×1920; FCPXML runs `export-project`. The Auto prompt picks the cut style (teaser/highlights/summary/full). |
| 15.16 | (Adversarial, VS-97) Prompt the Auto-lane agent to run an egress/destructive command (e.g. `curl` an external host, or write outside the project) | The command is **blocked before execution** by video-studio's PreToolUse hook (our `decide` policy) — even though the SDK would otherwise sandbox-and-run it. Verified: the agent reports it was "blocked before execution / needs approval". This closes the SDK-own-sandbox coverage gap. |
| 15.14 | With `ANTHROPIC_API_KEY` set, **Make my cut** (Auto lane) with a prompt | A live activity feed streams from Claude — "Session started", "Claude …", tool-use labels — ending in "Done". Every escalated tool the agent tries is gated by video-studio's policy (`decide`): allowed silently, or denied with our message. No key → a "Claude isn't connected" note. Drive the sidecar directly: `echo '{"type":"request","id":1,"step":"agent-run","params":{"prompt":"…"}}' \| ANTHROPIC_API_KEY=… node desktop/sidecar/host.mjs`. |
| 15.3 | After import, the app **auto-advances to Analyze**; the rail shows Analyze reachable (bright, clickable) and completed stages get a ✓ | Analyze shows an **engine label** ("runs on your machine — no AI, no cost") + a **step list** (what will run). |
| 15.4 | Click **Run analysis** on the Analyze screen | An indeterminate progress bar animates + a live status line streams `analyze-audio-events` output; on completion it writes `audio-events.json`, the step shows done, and the app **auto-advances to Design** (now unlocked). Distinct from import's scene detection. |
| 15.5 | Quit the window mid-analyze | The Node sidecar (and its analyzer child) are killed — no lingering `node` process. |

## Automated Coverage Summary

Covered by unit tests (do **not** re-test by hand):

- **`desktop/sidecar/protocol.mjs`** — NDJSON framing (`frameMessage`/`parseFrames`),
  `validateRequest`, and the host→shell message constructors
  (`tests/sidecar-protocol.test.mjs`). 100% coverage. Only the `host.mjs` stdio/spawn edge
  (§14) is manual.
- **`desktop/sidecar/steps.mjs`** — `toolArgv`, the analyzer progress parser, and each
  step's `buildCommand` descriptor (`tests/sidecar-protocol.test.mjs`). 100% coverage.
- **`desktop/sidecar/doctor.mjs`** — `doctorResultFromChecks` (rows + readiness verdict from
  probe results) (`tests/sidecar-protocol.test.mjs`). 100% coverage. Only the `which` probes
  in `host.mjs` (§14.7) + the Setup screen rendering (§15.2) are manual.
- **`desktop/sidecar/project.mjs`** — `presentArtifacts`, `deriveStages` (done/active/locked),
  `newProjectState`, `reconcileProject` (filesystem-wins) (`tests/sidecar-protocol.test.mjs`).
  100% coverage. Only the `host.mjs` readdir/read/write (§14.8/14.9) + the rail/New Project
  rendering (§15.6/15.7) are manual.
- **`desktop/sidecar/agent.mjs`** — `normalizeClaudeEvent` (tolerates unknown types),
  `eventToFeedEntry`, `validateCutPlan`, `isAuthFailure` (`tests/sidecar-protocol.test.mjs`).
  100% coverage. The live `@anthropic-ai/claude-agent-sdk` run + session resume + the
  `canUseTool` choke point are the I/O edge (not yet built — VS-91 tail / VS-92).
- **`desktop/sidecar/permissions.mjs`** — `classifyToolCall` (6 categories, traversal-safe),
  `isInProject`, `DEFAULT_POLICY`, `matchRule` (scope + precedence), `decide` (enforcement
  order), `deriveAllowedTools` (`tests/sidecar-protocol.test.mjs`). 100% coverage. The
  Permissions screen UI and the `canUseTool` wiring are not yet built (VS-92 tail).
- **`desktop/sidecar/config.mjs`** — `parseConfig` (tolerant), `addRecentProject`,
  `addRule`/`revokeRule`/`resetRules`, `setCategoryPolicy`, `effectivePolicy`,
  `serializeConfig` (`tests/sidecar-protocol.test.mjs`). 100% coverage. Only the `config-*`
  host steps' file read/write (§14.10) + the Permissions/recents screens are manual.

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
- **`tools/export-manifest.mjs`** — `buildManifest` (incl. the `audioTrack`),
  `framesToTimecode`, `segmentArgs`, `overlayArgs`, `audioTrackArgs`,
  `rebuildScript` (`tests/export-manifest.test.ts`). 100% coverage. The ffmpeg
  execution in `export-project.mjs` is §5 + §7.8 above.
- **`tools/fcpxml.mjs`** — `buildFcpxml`, `buildMulticamFcpxml`, `frameDuration`,
  `framesToTime`, `rationalTime` (`tests/fcpxml.test.ts`). 100% coverage of the XML
  generation, including the frame-aligned contiguous multicam spine (VS-36); FCP
  import itself is §5 / §7.9 (the multicam asset's real-FCP validation).
- **`tools/multicam-dsp.mjs`** — the DSP: FFT (`fftInPlace`, `crossCorrelate`,
  `crossCorrelatePhat`), offset/confidence (`findOffset`, `offsetSeconds`,
  `parabolicVertex`), `fitDrift`, `driftCorrection`, `atempoChain`
  (`tests/multicam-dsp.test.ts`). 100% coverage.
- **`tools/multicam.mjs`** — group-manifest + angle assembly: `classifySync`,
  `selectReference`, `buildGroupManifest`, `resolveAngleCuts`,
  `expandMulticamGroup`, `switchesFromDoc` (`tests/multicam.test.ts`). 100% coverage.
  The ffmpeg mono extraction + real-audio sync in `sync-multicam.mjs` is §7 above;
  the multicam export is §7.8; the `--switches` file wiring in the exporters is §12.
- **`tools/multicam-autocut.mjs`** — the auto angle selector: `audioContextAt`,
  `cutBoundaries`, `snapToBoundary`, `autoCut` (incl. the R-AC9 review signal), `evaluate`
  (`tests/multicam-autocut.test.ts`). 100% coverage — so §12's selection model +
  metrics are unit-covered; §12 rows exercise the CLI + the BYAM demonstration.
- **`tools/review-model.mjs`** — the review-UI core: `reviewSegments` (flag filtering +
  preview windows), `candidateAngles`, `applyReview` (picks + change history)
  (`tests/review-model.test.ts`). 100% coverage — so §13's which-cuts / candidate /
  write-back *logic* is unit-covered; §13 rows exercise the server, page, and ffmpeg
  preview extraction.
- **`tools/audio-events.mjs`** — `rmsEnvelope`, `detectOnsets`, `vocalSpans`,
  `sectionize`, `spectralFeatures`, `aggregateSpectral`, `structureBoundaries`,
  `buildAudioEvents`, `wordsFromWhisper` (`tests/audio-events.test.ts`).
- **`tools/wav-compat.mjs`** — `parseRiffChunks`, `classifyWavFcpCompat`,
  `fcpCompatWarning`, `fcpSidecarPath`, `fcpNormalizeArgs` (`tests/wav-compat.test.ts`).
  100% coverage — so §9's WAV FCP-compat *classification* + sidecar path/argv are
  unit-covered; §9 rows stay to verify the real file read + warning + the
  re-encode + the FCP import after normalization.
- **`tools/transitions-render.mjs`** — `TRANSITION_FFMPEG`, `xfadeId`,
  `TRANSITION_RECIPES`, `transitionRecipe`, `CHEVRON_EXPR`, `STATIC_EXPR`,
  `buildTransitionRenderPlan`, `transitionFilterComplex`, `buildWindowedRenderPlan`,
  `windowedClipFilter` (`tests/transitions-render.test.ts`). 100% coverage — so
  §10's transition→recipe maps + full-chain/windowed plan arithmetic + per-clip and
  whole-timeline `filter_complex` (incl. native Tier B/C) are unit-covered; §10 rows
  stay to verify the real ffmpeg render.
- **`tools/visual-saliency.mjs`** — `buildWindows`, `sourceTime`/`angleCoversWindow`,
  `normalizeMotion`, `parseVisionReply`, `combineSaliency`, `selectVisionWindows`,
  `sectionBoundaries`, `assembleWindowScore`, `buildSaliency`, `visionPrompt`
  (`tests/visual-saliency.test.ts`). 100% coverage — so §11's windowing, group-clock
  mapping, motion normalization, vision-reply parsing, gating, and schema are
  unit-covered; §11 rows stay to verify the real ffmpeg motion pass + Ollama calls.
  100% coverage. The ffmpeg mono extraction + whisper read + file write in
  `tools/analyze-audio-events.mjs` are §8 above.
- **`tools/multicam-groups.mjs`** — `slug`, `groupByFolder`,
  `groupByTimeWindow`, `eventKey`, `groupByFilename`, `proposeGroups`
  (`tests/multicam-groups.test.ts`). 100% coverage. The `sources.json` read +
  stat-based timestamps in `propose-groups.mjs` are §7.7 above.

Everything else in the tables above is genuinely manual because it shells out to
ffmpeg/whisper/ollama or launches a browser. If you find a way to automate one of
these items, move it into `tests/`, delete the row here, and add it to this list.

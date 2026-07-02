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
| 13.3 | Pick a different angle for one cut, add a note, click **Save** | The page shows the change count + the ready `export-multicam-fcpxml … --switches …` line. On disk: `switches.json` is rewritten in place with the new `memberId`, `switches.json.bak` holds the prior version, and `switches.history.json` gains an entry `{ atSeconds, from, to, at (ISO), note }`. |
| 13.4 | Re-run 13.1, click Save **without** changing anything | 0 changes; no `.bak` rewrite, no new history entry (only actual angle changes are recorded). |
| 13.5 | `--all` | Every cut is shown (not just flagged); `--port <n>` moves the server; `--context <s>` changes the preview lead/tail. |
| 13.6 | Feed the saved `switches.json` to §12.3 / §12.4 | The exporters honor the reviewed picks verbatim (it's the same hand-editable file). |
| 13.7 | **Re-propose (VS-67)** — run with `--audio-events <…> --saliency <…>` | A **Re-propose downstream** button appears (hidden without both inputs). Pick an angle for one cut, click it: the still-auto cuts re-flow around your pick (variety-aware, via `autoCut` locks), the page re-renders with the new flagged set, and your pick is preserved. Nothing is written yet. |
| 13.8 | After 13.7, click **Save** | Persists the re-proposed switches (`.bak` keeps the *original*, even across repeated saves) + a history entry `{ reproposedWithLocks: n }`. A second Save with no further change is a no-op. |

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

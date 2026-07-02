---
name: video-studio
description: Turn a long video into polished promo cuts on macOS — teasers, social (9:16) cuts, and long edits. Use when the user wants to cut/trim/edit a video, make a teaser/trailer/reel/promo, pull soundbites, add title cards/captions/overlays, or analyze a video's scenes. Produces finished .mp4/.mov files with ffmpeg, not just timelines. Pipeline: frame-accurate scene analysis (ffmpeg + Ollama vision) → whisper word-level timing → cut design → domotion-svg overlays rendered to alpha video → ffmpeg compositing → frame-sampled verification.
---

# video-studio

Cut long videos into compelling promo edits. **Always produce a finished video file**, then verify it by sampling frames — never stop at a timeline.

`TOOLKIT = {{TOOLKIT_DIR}}` — the installed toolkit. Commands below use it.

## macOS / environment notes (important)
- **You (Claude) are the vision model.** Scene descriptions are produced by *you* viewing the extracted frames — no Ollama needed. (Ollama is only used if the user explicitly asks for offline auto-descriptions via `--describe ollama`, which on macOS needs the Ollama *app* running in the GUI session for Metal/GPU — `open -a Ollama`.)
- `whisper`, `ffmpeg`/`ffprobe`, and the `svg-to-video` bin (`$TOOLKIT/node_modules/.bin/svg-to-video`) are all available.
- Everything is **24fps-aware but probe each video** — never assume fps.

## Step 1 — Probe + frame-accurate scene analysis (you describe the frames)
```bash
ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,nb_frames,width,height \
  -show_entries format=duration -of default=noprint_wrappers=1 "$VIDEO"
node "$TOOLKIT/dist/analyzer.js" "$VIDEO" "$DATADIR" --out "$WORK/video-scenes.json"
```
This does a full-decode scene detection (slow, cached/resumable) and **extracts one representative frame per scene** into `$DATADIR/frames/`. Each JSON record is frame-accurate — `start`/`end` as `HH:MM:SS:FF`, plus `startFrame`/`endFrame`/`startSeconds`/`endSeconds`, a **`framePath`**, and a blank `description`.

**Multiple sources?** When the user has several clips / folders to draw from, analyze them all at once:
```bash
node "$TOOLKIT/tools/analyze-sources.mjs" <file-or-folder>… --data-dir "$DATADIR" --out "$WORK/sources.json"
```
It expands folders (recursed, video extensions), gives each source a stable `id`, runs the analyzer per source, and writes `sources.json` (each source's `id`/path/fps/size + the union of scenes tagged with `sourceId`, source-relative times). Design cuts across sources by `(sourceId, in, out)`; resolve `sourceId` → the source path when you build the export cut spec (each cut clip carries its own `source`, so export/compositing already handles mixed sources — conform to one project fps/size). See [`docs/multiple-sources.md`](../../docs/multiple-sources.md).

**Multi-cam (same event from several cameras/recorders)?** When clips cover one event from different angles — especially with a separate audio recorder — **audio-sync them into a group** so the cut can switch angles over a shared timeline. See [`docs/multicam-sync.md`](../../docs/multicam-sync.md).
```bash
# (optional) let the tool propose groups from the pool, then confirm with the user:
node "$TOOLKIT/tools/propose-groups.mjs" "$WORK/sources.json"
# sync a group by audio (an audio-only recorder track becomes the reference AND master audio):
node "$TOOLKIT/tools/sync-multicam.mjs" <clipA> <clipB> <recorder.wav> --group-id ceremony --out "$WORK/multicam.json"
```
`multicam.json` carries each member's `offsetSeconds` + `confidence` + sync disposition (`auto`/`review`/`unsynced`; `unsynced` needs a manual offset — re-run with `--manual <id>=<sec>`). To build a switching cut, pick **angle switch points** over the shared timeline and expand the group into a cut spec with `expandMulticamGroup(group, switches, { name, width, height })` (from `$TOOLKIT/tools/multicam.mjs`): it returns silent video angle-segments over a **continuous master-audio track** (`audioTrack`), ready for the Step 7 export. The export plays the master audio under the switching angles, applies any drift retime, and emits FCPXML with the audio on a connected lane. **Or** hand the editor a *live* multicam clip they can re-cut in Final Cut Pro's angle viewer:
```bash
node "$TOOLKIT/tools/export-multicam-fcpxml.mjs" "$WORK/multicam.json" --width <w> --height <h> --switch 0=<id> --switch <t>=<id2> --out "<video-dir>/event.multicam.fcpxml"
```

**Auto-cut the angles (optional, VS-46/47):** instead of hand-picking switch points, let the toolkit propose them from the music + action. It correlates the synced group with `audio-events.json` (Step: run `analyze-audio-events.mjs`) and per-angle visual saliency (`analyze-visual-saliency.mjs`) — favoring the instrument angle during riffs and the active singer during vocals. Keep it a **separate, inspectable step**: propose, review the rationale, hand-edit if needed, then export.
```bash
node "$TOOLKIT/tools/propose-switches.mjs" "$WORK/multicam.json" \
  --audio-events "$WORK/audio-events.json" --saliency "$WORK/saliency.json" --eval
# → writes $WORK/switches.json (switches + a per-switch `rationale`) and prints why it cut to each angle
```
`switches.json` is a plain, editable `{ atSeconds, memberId }` list — **read the rationale, then hand-edit any cut you disagree with** before exporting. Feed it straight to either exporter with `--switches` (equivalent to the `--switch` flags; explicit `--switch` wins if you pass both):
```bash
node "$TOOLKIT/tools/export-multicam-fcpxml.mjs" "$WORK/multicam.json" --width <w> --height <h> --switches "$WORK/switches.json" --out "<video-dir>/event.multicam.fcpxml"
node "$TOOLKIT/tools/render-multicam-preview.mjs" "$WORK/multicam.json" --switches "$WORK/switches.json" --out "$WORK/preview.mp4"   # flat MP4 to eyeball the cut
```
With no `--saliency` it degrades to a footage round-robin; with no `--audio-events` it drops the riff/vocal priors. `--eval` prints quantitative metrics (% of instrumental time on the instrument angle, % of vocal time on the singer, shot-length stats).

**Then describe the scenes yourself:** to get an overview cheaply, tile the per-scene frames into contact sheets and Read those, rather than 50 separate reads:
```bash
ffmpeg -y -i "$DATADIR/frames/scene-%04d.jpg" -vf "scale=320:-1,tile=6x6" "$WORK/contact-%d.png"
```
View the contact sheet(s), write each scene's `description` back into `video-scenes.json`, and use it (with the transcript) to pick segments. (Offline alternative: `--describe ollama --model gemma4:12b` fills descriptions locally — see env notes.)

## Step 2 — Word-level timing with whisper (for soundbites)
Caption/transcript timestamps drift at the phrase level. For any spoken soundbite, get exact word boundaries: extract a short clip around the region and transcribe with `--word_timestamps`. **Keep the transcripts** — write them next to the analysis data (`$DATADIR/transcripts/`), not to throwaway `/tmp`. They're a durable record of how the audio was read and are reusable across cuts.
```bash
mkdir -p "$DATADIR/transcripts"
ffmpeg -y -ss $CLIP_START -i "$VIDEO" -t 12 -ac 1 -ar 16000 "$DATADIR/transcripts/sb-$CLIP_START.wav"
TMPDIR=/tmp whisper "$DATADIR/transcripts/sb-$CLIP_START.wav" --model large-v3-turbo --device cpu --language en \
  --word_timestamps True --output_format json --output_dir "$DATADIR/transcripts"
```
Parse `segments[].words[]` (`{word,start,end}`); **absolute time = clip_start + word.start**. Pick in/out on word boundaries (start ~40–80ms before the first word; end just after the last word, before the next word begins). Use `--device cpu` (the GPU is usually busy with Ollama). See [`docs/samples/`](../../docs/samples/) for an example transcript + scene breakdown.

## Step 3 — Design the cut
Read `video-scenes.json` + the transcript. Principles:
- **Teaser (~15s):** strong hook in the first 3s; 1–2 clean soundbites; fast B-roll; end card with CTA. Keep soundbite audio; leave B-roll **silent** unless told otherwise (the user adds music later).
- **Social 9:16 (≤3min):** vertical; favor talking-head close-ups; reframe/zoom screen-share UI (tiny text won't survive the crop).
- **Long (≤15min):** thoughtful, mostly linear, light trims.
- Order need not be linear, but communication must be clear. Pick B-roll **mid-scene** (stable) unless snapping to a scene cut helps.

## Step 4 — Title cards / captions / overlays (domotion-svg)
Generate an **animated SVG**, then render it to **alpha video**. For captions/lower-thirds/CTAs use the generator; for bespoke title cards/wordmarks author a custom domotion script (see `$TOOLKIT/promo-assets/*.mjs` for worked examples — rapid retro-variant wordmark, etc.).
```bash
# parameterized caption / lower-third / CTA → animated SVG
node "$TOOLKIT/tools/render-caption.mjs" --text "Your own private Kanban + List" \
  --style pill --position lower-third --duration 1.75 --out "$WORK/cap.svg"
# animated SVG → transparent ProRes 4444 (alpha) for compositing
"$TOOLKIT/node_modules/.bin/svg-to-video" "$WORK/cap.svg" -o "$WORK/cap.mov" \
  --format prores --background transparent --fps "$FPS"
```
`render-caption.mjs --help` lists styles (`pill`, `plain`, `cta`), positions, multi-line `--text`, `--accent`, `--icon`, `--width/--height/--fps`. Render at the video's real fps. Hold-frames are baked so the overlay doesn't fade mid-hold.

## Step 5 — Composite with ffmpeg
Extract each segment frame-accurately and normalize to one spec so segments concat cleanly; overlay alpha `.mov`s; concat. Keep soundbite audio, silence B-roll. Pattern (see `$TOOLKIT/promo-assets/build-teaser.sh` for a full worked example):
```bash
ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r $FPS \
     -c:a aac -b:a 192k -ar 48000 -ac 2 -video_track_timescale 12288 -movflags +faststart)
VF="scale=$W:$H,fps=$FPS,format=yuv420p,setsar=1"
# soundbite segment (sync audio + click-guard fades):
ffmpeg -y -ss $START -i "$VIDEO" -t $DUR -vf "$VF" \
  -af "afade=t=in:d=0.03,afade=t=out:st=$(echo "$DUR-0.04"|bc):d=0.04,aresample=48000" "${ENC[@]}" seg.mp4
# b-roll + caption overlay (silent):
ffmpeg -y -ss $START -i "$VIDEO" -i cap.mov -f lavfi -i "anullsrc=r=48000:cl=stereo" \
  -filter_complex "[0:v]$VF,trim=duration=$DUR,setpts=PTS-STARTPTS[b];[1:v]setpts=PTS-STARTPTS[o];\
   [b][o]overlay=0:0:eof_action=pass,format=yuv420p[v]" -map "[v]" -map 2:a -t $DUR "${ENC[@]}" seg.mp4
# end card (generated bg + wordmark + CTA; delay an overlay with setpts=PTS-STARTPTS+1.6/TB):
# concat identical-spec segments:
ffmpeg -y -f concat -safe 0 -i list.txt -c copy out.mp4
```
For **9:16**, change `$W:$H` to `1080:1920` and reframe sources with `crop`/`scale` + `overlay` (e.g. screen-share scaled into the top, talking head below). For cross-dissolves use `xfade`/`acrossfade` instead of concat.

## Step 6 — Verify (do not skip)
- Sample a frame from each segment and view them: `ffmpeg -ss $T -i out.mp4 -frames:v 1 f.png` → montage → Read the image. Confirm overlays composited, framing, legibility.
- Check audio levels per segment: `ffmpeg -i seg.mp4 -af volumedetect -f null -` (soundbites loud, B-roll ~ -91dB silent).
- **Re-whisper soundbite segments** to confirm the words are clean and complete (no clipped first/last word).

## Step 7 — (optional) Export for manual finishing in an NLE
When the user wants to add their own transitions/grade in Final Cut Pro (or another editor) instead of a finished render, export the **pieces** instead of compositing. Write a cut spec (the segments you chose + the overlays you rendered) and run the export tool — it emits each segment as ProRes 422 HQ, each overlay as ProRes 4444 (alpha), a `manifest.json` of target time ranges, and a `rebuild.sh` that reproduces the exact cut. See [`docs/editor-handoff.md`](../../docs/editor-handoff.md) for the cut-spec shape.
```bash
node "$TOOLKIT/tools/export-project.mjs" "$WORK/cut.json" --out "<video-dir>/teaser.studio-export"
```
The cut spec's `clips` reference each source by path + in/out seconds (`audio: keep|silent`); `overlays` reference the alpha `.mov`s you rendered in Step 4 with the clip they sit over + offset. An optional **`audioTrack`** (`{ source, in, durationSeconds }`) lays one continuous audio source under the whole timeline — used for **multi-cam** (silent angle segments + master audio), or a music bed. The export also writes a **`<name>.fcpxml`** — the user can import that straight into Final Cut Pro (segments on the storyline, overlays + master audio as connected clips) for their transition pass, or run `rebuild.sh` to re-composite the exact cut.

**Optional: suggest transitions** ([`docs/transitions.md`](../../docs/transitions.md)). Add a `transitions` array to the cut spec to pre-place FCP transitions at chosen cuts (the export bakes handle media into those segments and writes `<transition>` elements into the `.fcpxml`, ready to tweak/delete). Each entry: `{ "afterClip": <0-based clip index before the cut>, "name": "<transition>", "durationSeconds": <n>, "reason": "<why>" }`. **Choose per cut, and lean hard-cut by default** — list a transition only where it earns its place. The wired palette (use the exact `name`), grouped by feel:
- **Hard cut (omit the entry):** the default — energy, continuity, on-beat cuts, dialogue/soundbite joins; teasers + social cuts stay mostly hard.
- **Dissolve / fade — the safe, restrained choices.** `Cross Dissolve` (~10–20 frames) for a time passage, mood/topic shift, or smoothing a B-roll montage (the long-edit archetype). `Fade To Color` (~0.5–1 s; "Dip to Color" is an alias) for a chapter/scene break, intro/outro, or tonal reset.
- **Movements — dynamic, for energetic/social cuts:** `Slide`, `Push`.
- **Wipes — graphic, playful; use sparingly:** `Wipe`, `Diagonal`, `Clock`, `Circle`, `Chevron`, `Center`.
- **Insets / splits — stylized, multi-image; sparing accents:** `Circle Inset`, `Rectangle Inset`, `Shapes Inset`, `Side-by-Side Split`, `Top & Bottom Split`.
- **Lights — glitch/noise accent, edgy:** `Static`.

Default to **dissolve/fade** unless the video's style is explicitly playful/energetic; reserve the wipes/insets/Static for matching content (avoid them in restrained/corporate edits). Tune by **video type** (teaser → snappy/hard; long edit → smoother dissolves), scene descriptions (mood shift vs continuous action), and pacing — and put the *why* in each `reason` so the user can audit it. (The motion-template transitions — wipes/insets/Static/Push — use FCP-internal `.motr` paths captured from a real export; if a future FCP version relocates them, prefer the `FxPlug` ones.)

**Finish the transitions *without* FCP** ([`docs/render-transitions.md`](../../docs/render-transitions.md)). When the cut spec has a `transitions` block, the export bakes handle media into the affected segments so you can bake those transitions straight into a finished `.mov` — no NLE needed:
```bash
node "$TOOLKIT/tools/render-transitions.mjs" "<video-dir>/teaser.studio-export/manifest.json" [--out <file.mov>] [--full-chain]
```
So an editor-handoff export offers three finishing paths off the same `transitions` block: **`rebuild.sh`** (plain cut, no transitions), the **`.fcpxml`** (import to FCP for the transition pass), and **`render-transitions.mjs`** (bake them now, no FCP). The **windowed default is fast** — it re-encodes only the short overlap at each cut (cost ~ Σ transition durations), and it's the **only path that renders Tier-B/C looks natively** (chevron/static/inset/split); `--full-chain` re-encodes the whole timeline and degrades Tier B/C to the nearest `xfade`.

## Output conventions
- Write finished cuts next to the source (e.g. `<video-dir>/teaser.mp4`). Scratch encodes can go in a work dir or `/tmp`, **but keep the AI-interpretation intermediates**: the scene breakdown (`$DATADIR/timeline.json`, with descriptions) and the whisper transcripts (`$DATADIR/transcripts/`) are a durable record of how the model read the footage — don't bury them in `/tmp`.
- Save the assembly as a shell script alongside the output so the user can re-run/tweak.
- Keep CTAs editable: put a `{{PLACEHOLDER}}` URL in the caption text and tell the user how to swap it.

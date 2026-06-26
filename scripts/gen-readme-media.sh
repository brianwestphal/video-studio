#!/usr/bin/env bash
set -euo pipefail

# Regenerate the README demo media from a sample video, using the video-studio
# toolkit itself (the scene analyzer, render-caption, and ffmpeg compositing).
# Outputs land in docs/media/. Safe to re-run after changes.
#
# Usage:
#   bash scripts/gen-readme-media.sh
#   SRC=/path/to/other.mp4 bash scripts/gen-readme-media.sh
#
# Defaults to ./external/tears-of-steel.mp4 (gitignored; drop the Blender short
# there). Needs: ffmpeg/ffprobe, node, and a Chromium for svg-to-video/render-
# caption (Playwright's browser — `npx playwright install chromium` if missing).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$ROOT/external/tears-of-steel.mp4}"
OUT="${OUT:-$ROOT/docs/media}"
WORK="${TMPDIR:-/tmp}/vs-readme-media"
SVG2VIDEO="$ROOT/node_modules/.bin/svg-to-video"

info() { printf '\n\033[36m\033[1m>>>\033[0m %s\n' "$1"; }

[ -f "$SRC" ] || { echo "Source video not found: $SRC"; echo "Put the sample video there or set SRC=…"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH"; exit 1; }
[ -x "$SVG2VIDEO" ] || { echo "svg-to-video not found ($SVG2VIDEO) — run 'npm install' in $ROOT"; exit 1; }
[ -f "$ROOT/dist/analyzer.js" ] || { info "Building analyzer…"; npm --prefix "$ROOT" run build; }

mkdir -p "$OUT" "$WORK"

# --- probe geometry + fps -------------------------------------------------
read -r W H < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$SRC" | tr ',' ' ')
FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$SRC" | awk -F/ '{ printf "%.0f", ($2 ? $1/$2 : $1) }')
TW=1280
TH=$(( ( (TW * H / W) + 1) / 2 * 2 ))   # preserve aspect, force even height
info "source ${W}x${H} @ ${FPS}fps  →  demo canvas ${TW}x${TH}"

ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r "$FPS"
     -c:a aac -b:a 128k -ar 48000 -ac 2 -movflags +faststart)
VF="scale=${TW}:${TH},fps=${FPS},format=yuv420p,setsar=1"
SILENCE=(-f lavfi -i "anullsrc=r=48000:cl=stereo")

# =========================================================================
# 1) scene-analysis.png — contact sheet of one frame per detected scene
# =========================================================================
info "Running the scene analyzer (full-decode; cached/resumable — may take a while on a long 4K file)…"
node "$ROOT/dist/analyzer.js" "$SRC" "$WORK/data" --out "$WORK/scenes.json"

info "Tiling per-scene frames into docs/media/scene-analysis.png…"
# Take the first 24 scene frames into a 6x4 grid. (If the clip has <24 scenes,
# lower the tile grid below.)
ffmpeg -y -loglevel error -i "$WORK/data/frames/scene-%04d.jpg" \
  -vf "scale=240:-1,tile=6x4:padding=8:margin=8:color=0x15171c" -frames:v 1 \
  "$OUT/scene-analysis.png"

# =========================================================================
# 2) caption-overlay.png — a caption composited onto a real frame
# =========================================================================
info "Rendering a caption overlay → docs/media/caption-overlay.png…"
node "$ROOT/tools/render-caption.mjs" --style pill --position lower-third \
  --text "Frame-accurate cuts, driven from Claude" \
  --duration 2 --fps "$FPS" --width "$TW" --height "$TH" --out "$WORK/cap.svg"
"$SVG2VIDEO" "$WORK/cap.svg" -o "$WORK/cap.mov" --format prores --background transparent --fps "$FPS"
# Composite over a 2s still slice, then grab a frame from the solid hold (~1.0s).
ffmpeg -y -loglevel error -ss 90 -i "$SRC" -i "$WORK/cap.mov" -t 2 -filter_complex \
  "[0:v]${VF},trim=duration=2,setpts=PTS-STARTPTS[bg];[1:v]setpts=PTS-STARTPTS[o];[bg][o]overlay=0:0:eof_action=pass,format=yuv420p[v]" \
  -map "[v]" "$WORK/capframe.mp4"
ffmpeg -y -loglevel error -ss 1.0 -i "$WORK/capframe.mp4" -frames:v 1 "$OUT/caption-overlay.png"

# =========================================================================
# 3) teaser-hero.gif — a short montage: mid-scene B-roll + a caption + end card
# =========================================================================
info "Picking well-spaced mid-scene moments from the analyzer output…"
# Read scenes.json; choose 4 evenly-spaced scenes long enough to hold a 1.6s
# clip, and emit the clip start (scene middle − 0.8s). Plain $(...) array, not
# `mapfile` — macOS ships bash 3.2, which has no mapfile. (Output is one
# whitespace-free number per line, so word-splitting is safe here.)
# shellcheck disable=SC2207
STARTS=( $(node -e '
  const s = require(process.argv[1]);
  const long = s.filter(x => (x.endSeconds - x.startSeconds) >= 2.0);
  const n = 4, out = [];
  for (let i = 0; i < n && long.length; i++) {
    const sc = long[Math.floor((i + 1) * long.length / (n + 1))];
    out.push(Math.max(0, (sc.startSeconds + sc.endSeconds) / 2 - 0.8).toFixed(2));
  }
  console.log(out.join("\n"));
' "$WORK/scenes.json") )
info "B-roll starts: ${STARTS[*]}"

DUR=1.6
# Caption for the second clip (lower-third).
node "$ROOT/tools/render-caption.mjs" --style pill --position lower-third \
  --text "Teasers, social cuts & long edits" --duration "$DUR" --fps "$FPS" \
  --width "$TW" --height "$TH" --out "$WORK/t-cap.svg"
"$SVG2VIDEO" "$WORK/t-cap.svg" -o "$WORK/t-cap.mov" --format prores --background transparent --fps "$FPS"
# CTA end-card caption.
node "$ROOT/tools/render-caption.mjs" --style cta --position center \
  --text "Made with video-studio" --text "npx video-studio" --duration 2.4 --fps "$FPS" \
  --width "$TW" --height "$TH" --out "$WORK/t-end.svg"
"$SVG2VIDEO" "$WORK/t-end.svg" -o "$WORK/t-end.mov" --format prores --background transparent --fps "$FPS"

LIST="$WORK/list.txt"; : > "$LIST"
idx=0
for start in "${STARTS[@]}"; do
  seg="$WORK/seg${idx}.mp4"
  if [ "$idx" -eq 1 ]; then
    # captioned B-roll
    ffmpeg -y -loglevel error -ss "$start" -i "$SRC" -i "$WORK/t-cap.mov" "${SILENCE[@]}" -filter_complex \
      "[0:v]${VF},trim=duration=${DUR},setpts=PTS-STARTPTS[b];[1:v]setpts=PTS-STARTPTS[o];[b][o]overlay=0:0:eof_action=pass,format=yuv420p[v]" \
      -map "[v]" -map 2:a -t "$DUR" "${ENC[@]}" "$seg"
  else
    ffmpeg -y -loglevel error -ss "$start" -i "$SRC" "${SILENCE[@]}" \
      -vf "$VF" -map 0:v -map 1:a -t "$DUR" "${ENC[@]}" "$seg"
  fi
  printf "file '%s'\n" "$seg" >> "$LIST"
  idx=$((idx + 1))
done

# end card (dark bg + CTA caption)
endseg="$WORK/seg_end.mp4"
ffmpeg -y -loglevel error -f lavfi -i "color=c=0x15171c:s=${TW}x${TH}:r=${FPS}" -i "$WORK/t-end.mov" "${SILENCE[@]}" \
  -filter_complex "[0:v]trim=duration=2.4,setpts=PTS-STARTPTS[bg];[1:v]setpts=PTS-STARTPTS[o];[bg][o]overlay=0:0:eof_action=pass,format=yuv420p[v]" \
  -map "[v]" -map 2:a -t 2.4 "${ENC[@]}" "$endseg"
printf "file '%s'\n" "$endseg" >> "$LIST"

info "Concatenating the teaser…"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$LIST" -c copy "$WORK/teaser.mp4"

# The README hero is a <picture>: an animated WebP primary + a GIF fallback for
# renderers that can't do WebP. WEBPFPS / WEBPW / WEBPQ are the shared size knobs.
WEBPFPS="${WEBPFPS:-12}"
WEBPW="${WEBPW:-760}"
WEBPQ="${WEBPQ:-75}"

# 1) Animated WebP (primary) — straight from full-color PNG frames through a
#    single encode (NO intermediate GIF, which would lose quality twice). Needs
#    img2webp (ships with the `webp` brew package).
if command -v img2webp >/dev/null; then
  FRAMES="$WORK/frames-webp"; rm -rf "$FRAMES"; mkdir -p "$FRAMES"
  ffmpeg -y -loglevel error -i "$WORK/teaser.mp4" -vf "fps=${WEBPFPS},scale=${WEBPW}:-2:flags=lanczos" "$FRAMES/f-%04d.png"
  # img2webp's lossy mode merges near-identical consecutive frames (longer
  # per-frame durations) — total runtime is preserved; that's why it stays small.
  img2webp -loop 0 -lossy -q "$WEBPQ" -d "$(( 1000 / WEBPFPS ))" "$FRAMES"/f-*.png -o "$OUT/teaser-hero.webp" >/dev/null
else
  echo "(img2webp not found — skipping the WebP; \`brew install webp\` to enable it. The GIF fallback below still covers the README.)"
fi

# 2) Palette GIF (fallback) — heavier, but every renderer can show it. Matched to
#    the WebP's size/fps.
ffmpeg -y -loglevel error -i "$WORK/teaser.mp4" \
  -vf "fps=${WEBPFPS},scale=${WEBPW}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  "$OUT/teaser-hero.gif"

info "Done. Wrote:"
ls -lh "$OUT"/teaser-hero.webp "$OUT"/teaser-hero.gif "$OUT"/scene-analysis.png "$OUT"/caption-overlay.png 2>/dev/null
echo ""
echo "Hero is a <picture> in the README: teaser-hero.webp (primary) + teaser-hero.gif (fallback)."
echo "Too big / too small? Re-run with e.g. WEBPQ=65 WEBPW=640 WEBPFPS=10, or"
echo "trim the clip count / DUR near the top of this script."

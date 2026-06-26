#!/usr/bin/env bash
# Assemble the HotSheet teaser cut from chat-with-carol.mov + domotion overlays.
# Frame-accurate (24fps) segment extraction → caption/end-card overlays (alpha
# ProRes) composited → concatenated. Two key soundbites keep sync audio; the
# B-roll/end-card segments are silent (music to be added later).
set -euo pipefail

# WORKED EXAMPLE for one specific recording — the cut points below are pinned to
# that source. Override the paths via env to adapt it to your own footage:
#   SRC     source video            (required — set to your own .mov/.mp4)
#   ASSETS  overlay alpha .movs dir  (wordmark.mov, cap2.mov, cap3.mov, cap6.mov)
#   WORK    scratch dir
#   OUT     final teaser path        (default: teaser.mp4 next to SRC)
SRC="${SRC:?set SRC to your source video, e.g. SRC=~/clip.mov}"
A="${ASSETS:-${TMPDIR:-/tmp}/video-studio-teaser/assets}"   # overlay assets: wordmark.mov, cap2.mov, cap3.mov, cap6.mov
W="${WORK:-${TMPDIR:-/tmp}/video-studio-teaser/work}"       # work dir
OUT="${OUT:-$(dirname "$SRC")/teaser.mp4}"
mkdir -p "$W"

# common encode params so segments concat cleanly
ENC=(-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 24
     -c:a aac -b:a 192k -ar 48000 -ac 2 -video_track_timescale 12288 -movflags +faststart)
VF="scale=1920:1080,fps=24,format=yuv420p,setsar=1"

# soundbite cut points pinned via whisper word-level timestamps (24fps):
#   seg1 "it"=36.20s … "free."=39.02s  → 36.18 → 39.20 (3.02s)
echo "── seg1: lead-in soundbite (Brian: 'it runs locally … and it's free')"
ffmpeg -y -loglevel error -ss 36.18 -i "$SRC" -t 3.02 \
  -vf "$VF" \
  -af "afade=t=in:d=0.03,afade=t=out:st=2.98:d=0.04,aresample=48000" \
  "${ENC[@]}" "$W/seg1.mp4"

# helper for a caption-overlaid, SILENT b-roll segment
# args: name  start  dur  caption.mov
broll_caption () {
  local name="$1" start="$2" dur="$3" cap="$4"
  echo "── $name: b-roll + caption overlay (silent)"
  ffmpeg -y -loglevel error -ss "$start" -i "$SRC" -i "$cap" -f lavfi -i "anullsrc=r=48000:cl=stereo" \
    -filter_complex \
      "[0:v]$VF,trim=duration=$dur,setpts=PTS-STARTPTS[b];[1:v]setpts=PTS-STARTPTS[o];[b][o]overlay=0:0:eof_action=pass,format=yuv420p[v]" \
    -map "[v]" -map 2:a -t "$dur" "${ENC[@]}" "$W/$name.mp4"
}

broll_caption seg2 2893.0 2.25 "$A/cap2.mov"   # HotSheet board
broll_caption seg3 1189.0 2.25 "$A/cap3.mov"   # Claude working in the drawer

#   seg4 "This"=2235.02s … "design"=2237.04s ("with the font" follows) → 2234.95 → 2237.12 (2.17s)
echo "── seg4: payoff soundbite (Caroline: 'this right here is better than my design')"
ffmpeg -y -loglevel error -ss 2234.95 -i "$SRC" -t 2.17 \
  -vf "$VF" \
  -af "afade=t=in:d=0.03,afade=t=out:st=2.13:d=0.04,aresample=48000" \
  "${ENC[@]}" "$W/seg4.mp4"

echo "── seg5: landing page reveal (silent)"
ffmpeg -y -loglevel error -ss 2208.0 -i "$SRC" -f lavfi -i "anullsrc=r=48000:cl=stereo" \
  -vf "$VF" -map 0:v -map 1:a -t 1.75 "${ENC[@]}" "$W/seg5.mp4"

echo "── seg6: end card (dark bg + animated wordmark + CTA caption, silent)"
ffmpeg -y -loglevel error \
  -f lavfi -i "color=c=0x15171c:s=1920x1080:r=24" \
  -i "$A/wordmark.mov" -i "$A/cap6.mov" \
  -f lavfi -i "anullsrc=r=48000:cl=stereo" \
  -filter_complex \
    "[0:v]trim=duration=4,setpts=PTS-STARTPTS[bg];\
     [1:v]setpts=PTS-STARTPTS[wm];[bg][wm]overlay=0:0:eof_action=pass[t];\
     [2:v]setpts=PTS-STARTPTS+1.6/TB[cta];[t][cta]overlay=0:0:eof_action=pass,format=yuv420p[v]" \
  -map "[v]" -map 3:a -t 4 "${ENC[@]}" "$W/seg6.mp4"

echo "── concat"
printf "file '%s'\n" "$W"/seg1.mp4 "$W"/seg2.mp4 "$W"/seg3.mp4 "$W"/seg4.mp4 "$W"/seg5.mp4 "$W"/seg6.mp4 > "$W/list.txt"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$W/list.txt" -c copy "$OUT"

echo "── done: $OUT"
ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,codec_name -of default=noprint_wrappers=1 "$OUT"

#!/usr/bin/env bash
set -euo pipefail

# Regenerate the committed reference *transcript* sample from the sample video,
# using the same whisper word-level pass the skill uses for soundbites. Output:
#   docs/samples/tears-of-steel.transcript.json   (word-level, absolute times)
#   docs/samples/tears-of-steel.transcript.txt    (readable, timecoded)
#
# The companion scene-descriptions sample (docs/samples/tears-of-steel.scenes.json)
# is authored by Claude viewing the analyzer's extracted frames (the default
# `--describe none` flow) — that's not reproducible from a script, so it isn't
# regenerated here.
#
# Usage:
#   bash scripts/gen-readme-samples.sh
#   SRC=/path/to/other.mp4 CLIP_START=18 CLIP_DUR=60 bash scripts/gen-readme-samples.sh
#
# Needs: ffmpeg, node, and whisper (`brew install openai-whisper`); the
# large-v3-turbo model downloads on first use.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SRC:-$ROOT/external/tears-of-steel.mp4}"
OUT="${OUT:-$ROOT/docs/samples}"
WORK="${TMPDIR:-/tmp}/vs-readme-samples"
CLIP_START="${CLIP_START:-18}"   # opening breakup dialogue
CLIP_DUR="${CLIP_DUR:-60}"
ATTRIB="Tears of Steel (© Blender Foundation, CC BY 3.0 — mango.blender.org)"

info() { printf '\n\033[36m\033[1m>>>\033[0m %s\n' "$1"; }

[ -f "$SRC" ] || { echo "Source video not found: $SRC"; exit 1; }
command -v whisper >/dev/null || { echo "whisper not found — brew install openai-whisper"; exit 1; }
mkdir -p "$OUT" "$WORK"

info "Extracting dialogue audio (${CLIP_START}s + ${CLIP_DUR}s, mono 16 kHz)…"
ffmpeg -y -loglevel error -ss "$CLIP_START" -i "$SRC" -t "$CLIP_DUR" -ac 1 -ar 16000 "$WORK/seg.wav"

info "Transcribing with whisper (word timestamps; CPU, may take a couple minutes)…"
TMPDIR="$WORK" whisper "$WORK/seg.wav" --model large-v3-turbo --device cpu --language en \
  --word_timestamps True --output_format json --output_dir "$WORK/wh" >/dev/null

info "Rebasing to absolute video time + writing samples…"
SRC_ATTRIB="$ATTRIB" CLIP_START="$CLIP_START" CLIP_DUR="$CLIP_DUR" OUT="$OUT" \
node -e '
  const fs = require("fs");
  const j = require(process.argv[1]);
  const off = Number(process.env.CLIP_START);
  const r = n => +(n + off).toFixed(2);
  const tc = s => { const h=Math.floor(s/3600), m=Math.floor(s%3600/60), x=(s%60);
    return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+x.toFixed(2).padStart(5,"0"); };
  const segs = j.segments.map(s => ({
    start:r(s.start), end:r(s.end), text:s.text.trim(),
    words:(s.words||[]).map(w => ({ word:w.word.trim(), start:r(w.start), end:r(w.end) })),
  }));
  const out = process.env.OUT;
  fs.writeFileSync(out+"/tears-of-steel.transcript.json", JSON.stringify({
    source: process.env.SRC_ATTRIB,
    note: "Representative excerpt of the video-studio whisper word-level pass (model large-v3-turbo). Timestamps are absolute video time in seconds.",
    clip: { startSeconds: off, durationSeconds: Number(process.env.CLIP_DUR) },
    segments: segs,
  }, null, 2) + "\n");
  const txt = [
    "# Tears of Steel — transcript excerpt",
    "# Source: " + process.env.SRC_ATTRIB,
    "# video-studio / whisper large-v3-turbo, word-level timing; times = absolute video time", "",
    ...segs.map(s => `[${tc(s.start)} → ${tc(s.end)}]  ${s.text}`),
  ].join("\n") + "\n";
  fs.writeFileSync(out+"/tears-of-steel.transcript.txt", txt);
' "$WORK/wh/seg.json"

info "Done:"
ls -lh "$OUT"/tears-of-steel.transcript.json "$OUT"/tears-of-steel.transcript.txt

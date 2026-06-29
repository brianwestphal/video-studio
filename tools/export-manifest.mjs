// Pure logic for the editor-handoff export (docs/editor-handoff.md): turn a cut
// spec into the timeline manifest, the per-segment / per-overlay ffmpeg commands,
// and the rebuild script. No I/O here (durations are passed in), so it's all
// unit-testable; the actual ffmpeg runs live in export-project.mjs.

const pad = (n) => String(n).padStart(2, "0");

// Frame index → SMPTE-style HH:MM:SS:FF (non-drop; integer/CFR fps assumed).
export function framesToTimecode(frame, fps) {
  const f = Math.round(fps);
  const totalSeconds = Math.floor(frame / f);
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}:${pad(frame % f)}`;
}

const seg = (n) => `seg-${String(n).padStart(3, "0")}.mov`;
const ov = (n) => `ov-${String(n).padStart(3, "0")}.mov`;

// Build the final-timeline manifest from a cut spec. `overlayDurations[i]` is the
// measured duration (seconds) of overlay i's source file (probed by the caller),
// used only when the overlay doesn't specify its own `duration`.
export function buildManifest(spec, overlayDurations = []) {
  const project = spec.project || {};
  const fps = project.fps;
  if (!fps || !Number.isFinite(fps)) throw new Error("export: project.fps is required");
  const clips = spec.clips || [];
  if (clips.length === 0) throw new Error("export: at least one clip is required");

  const t = (s) => ({ seconds: +s.toFixed(3), frame: Math.round(s * fps), timecode: framesToTimecode(Math.round(s * fps), fps) });

  let cursor = 0;
  const segments = clips.map((clip, i) => {
    if (!(clip.out > clip.in)) throw new Error(`export: clip ${i} has out (${clip.out}) <= in (${clip.in})`);
    // A drift `rateCorrection` stretches the source span (clip.in..clip.out) to
    // `rate`× its length on the timeline, so the on-timeline duration is scaled.
    const rate = clip.rateCorrection ?? 1;
    const duration = (clip.out - clip.in) * rate;
    const targetStart = cursor;
    cursor += duration;
    return {
      index: i + 1,
      file: `segments/${seg(i + 1)}`,
      source: clip.source,
      sourceIn: +clip.in.toFixed(3),
      sourceOut: +clip.out.toFixed(3),
      audio: clip.audio === "silent" ? "silent" : "keep",
      durationSeconds: +duration.toFixed(3),
      ...(rate !== 1 ? { rateCorrection: rate } : {}),
      target: { start: t(targetStart), end: t(cursor) },
    };
  });
  const totalSeconds = cursor;

  const overlays = (spec.overlays || []).map((o, i) => {
    const overIdx = o.overClip ?? 0;
    const base = segments[overIdx];
    if (!base) throw new Error(`export: overlay ${i} references missing clip ${overIdx}`);
    const start = base.target.start.seconds + (o.atOffset || 0);
    const duration = o.duration ?? overlayDurations[i];
    if (!(duration > 0)) throw new Error(`export: overlay ${i} has no usable duration`);
    return {
      index: i + 1,
      file: `overlays/${ov(i + 1)}`,
      source: o.file,
      position: o.position || "lower-third",
      overSegment: overIdx + 1,
      durationSeconds: +duration.toFixed(3),
      target: { start: t(start), end: t(start + duration) },
    };
  });

  // Optional continuous master-audio track (the multi-cam case, docs/multicam.md):
  // one audio source played under the whole timeline while the video switches
  // angles. Segments are expected to be silent when this is present.
  let audioTrack = null;
  if (spec.audioTrack) {
    const a = spec.audioTrack;
    const duration = a.durationSeconds ?? totalSeconds;
    if (!(duration > 0)) throw new Error("export: audioTrack has no usable duration");
    audioTrack = {
      file: "audio/master.mov",
      source: a.source,
      sourceIn: +(a.in || 0).toFixed(3),
      durationSeconds: +duration.toFixed(3),
    };
  }

  return {
    project: {
      name: project.name || "studio-export",
      fps,
      width: project.width,
      height: project.height,
      totalSeconds: +totalSeconds.toFixed(3),
      totalTimecode: framesToTimecode(Math.round(totalSeconds * fps), fps),
    },
    segments,
    overlays,
    audioTrack,
  };
}

// Extract the master-audio track to a PCM .mov, trimmed to the timeline length.
// Video is dropped; this is muxed under the silent video in the rebuild.
export function audioTrackArgs(audioTrack, outPath) {
  return ["-y", "-ss", String(audioTrack.sourceIn), "-i", audioTrack.source,
    "-t", audioTrack.durationSeconds.toFixed(3), "-vn", "-c:a", "pcm_s16le", "-ar", "48000", outPath];
}

// ProRes 422 HQ extraction of one clip, frame-accurate, audio kept or silenced.
// A `rateCorrection` (multi-cam drift retime) time-stretches the video by `rate`
// so its source span (which is 1/rate of the timeline slot) fills the slot; the
// clip is silent in that case, so only the video PTS is retimed.
export function segmentArgs(project, clip, outPath) {
  const scale = `scale=${project.width}:${project.height}:flags=lanczos,setsar=1`;
  const rate = clip.rateCorrection;
  const vf = rate && rate !== 1 ? `${scale},setpts=${rate}*PTS` : scale;
  const enc = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-r", String(project.fps)];
  const dur = (clip.out - clip.in).toFixed(3);
  if (clip.audio === "silent") {
    return ["-y", "-ss", String(clip.in), "-i", clip.source, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      "-map", "0:v:0", "-map", "1:a:0", "-t", dur, "-vf", vf, ...enc, "-c:a", "pcm_s16le", "-ar", "48000", outPath];
  }
  return ["-y", "-ss", String(clip.in), "-i", clip.source,
    "-map", "0:v:0", "-map", "0:a:0?", "-t", dur, "-vf", vf, ...enc, "-c:a", "pcm_s16le", "-ar", "48000", outPath];
}

// Transcode an overlay's alpha source file to ProRes 4444, trimmed to its
// duration. `sourceFile` is the overlay's `file` from the cut spec.
export function overlayArgs(project, sourceFile, durationSeconds, outPath) {
  return ["-y", "-i", sourceFile, "-t", durationSeconds.toFixed(3),
    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-r", String(project.fps), "-an", outPath];
}

// A bash script that re-composites the exact final cut from the exported pieces,
// so the manifest is verifiably complete. Segments concat on the base track;
// overlays composite at their target offsets.
export function rebuildScript(manifest) {
  const { fps, width, height } = manifest.project;
  // With a continuous master-audio track, the video is built first then the
  // master audio is muxed under it; otherwise the video result is the final out.
  const vidOut = manifest.audioTrack ? '"$OUT.video.mov"' : '"$OUT"';
  const lines = [
    "#!/usr/bin/env bash",
    "# Re-composite the exact final cut from the exported segments + overlays.",
    "# Generated by video-studio export (docs/editor-handoff.md).",
    "set -euo pipefail",
    'cd "$(dirname "$0")"',
    `FPS=${fps}; W=${width}; H=${height}`,
    'OUT="${1:-rebuilt.mov}"',
    "",
    "# 1) concat the segments (already one spec) into the base track",
    "printf '' > segments/list.txt",
  ];
  for (const s of manifest.segments) lines.push(`printf "file '%s'\\n" "${s.file.replace("segments/", "")}" >> segments/list.txt`);
  lines.push(
    'ffmpeg -y -loglevel error -f concat -safe 0 -i segments/list.txt -c copy "$OUT.base.mov"',
    "",
    "# 2) overlay each alpha clip at its target start",
  );
  if (manifest.overlays.length === 0) {
    lines.push(`mv "$OUT.base.mov" ${vidOut}`);
  } else {
    const inputs = ['-i "$OUT.base.mov"'];
    const filters = [];
    let prev = "0:v";
    manifest.overlays.forEach((o, i) => {
      inputs.push(`-i "${o.file}"`);
      const idx = i + 1;
      const start = o.target.start.seconds;
      filters.push(`[${idx}:v]setpts=PTS-STARTPTS+${start}/TB[o${idx}]`);
      filters.push(`[${prev}][o${idx}]overlay=0:0:eof_action=pass[v${idx}]`);
      prev = `v${idx}`;
    });
    lines.push(
      `ffmpeg -y -loglevel error ${inputs.join(" ")} \\`,
      `  -filter_complex "${filters.join(";")}" -map "[${prev}]" -map 0:a? \\`,
      `  -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -r "$FPS" -c:a pcm_s16le ${vidOut}`,
      'rm -f "$OUT.base.mov"',
    );
  }
  if (manifest.audioTrack) {
    lines.push(
      "",
      "# 3) mux the continuous master audio under the (silent) video",
      `ffmpeg -y -loglevel error -i ${vidOut} -i "${manifest.audioTrack.file}" \\`,
      `  -map 0:v:0 -map 1:a:0 -c:v copy -c:a pcm_s16le -shortest "$OUT"`,
      `rm -f ${vidOut}`,
    );
  }
  lines.push('echo "wrote $OUT"', "");
  return lines.join("\n");
}

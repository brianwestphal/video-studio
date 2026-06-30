// Thin I/O wrapper around tools/wav-compat.mjs: read a file's RIFF header and warn
// (to stderr) when a WAV source won't import cleanly into Final Cut Pro. The pure
// parse/classify/format logic is in wav-compat.mjs (100% unit-tested); the file
// read here is manual/pipeline-tested (docs/manual-test-plan.md). Used by
// sync-multicam and export-multicam-fcpxml on their audio members.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { classifyWavFcpCompat, fcpCompatWarning, fcpNormalizeArgs, fcpSidecarPath, parseRiffChunks } from "./wav-compat.mjs";

// Read up to `bytes` from the start of `path` (the RIFF header; the chunk table +
// metadata precede the audio data, so 64 KB is ample). Returns a Uint8Array of the
// bytes actually read.
export function readRiffHeader(path, bytes = 65536) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// Ensure `path` is an FCP-importable WAV. Reads + classifies the header; then:
//   - FCP-safe / not-a-WAV / unreadable → returns the path unchanged.
//   - needs normalization + `normalize` false → warns to stderr (warn-only, VS-40)
//     and returns the path unchanged.
//   - needs normalization + `normalize` true → writes (or reuses a fresh) canonical
//     `<name>.fcp.wav` sidecar via ffmpeg and returns THAT path (VS-53).
// Returns { path, normalized }. Never throws on a read failure — a compatibility
// check must not break sync/export.
export function ensureFcpCompatAudio(path, { label = path, normalize = false } = {}) {
  let classification;
  try {
    classification = classifyWavFcpCompat(parseRiffChunks(readRiffHeader(path)));
  } catch {
    return { path, normalized: false }; // unreadable / not a real file → leave as-is
  }
  if (!classification.isWav || classification.safe) return { path, normalized: false };

  if (!normalize) {
    console.warn(fcpCompatWarning(label, classification));
    return { path, normalized: false };
  }

  const out = fcpSidecarPath(path);
  // Reuse an existing sidecar that is at least as new as the source; else re-encode.
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(path).mtimeMs) {
    console.warn(`Using existing FCP-safe WAV for ${label}: ${out}`);
  } else {
    execFileSync("ffmpeg", fcpNormalizeArgs(path, out));
    console.warn(`Normalized ${label} → ${out} (canonical FCP-safe WAV).`);
  }
  return { path: out, normalized: true };
}

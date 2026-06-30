// Thin I/O wrapper around tools/wav-compat.mjs: read a file's RIFF header and warn
// (to stderr) when a WAV source won't import cleanly into Final Cut Pro. The pure
// parse/classify/format logic is in wav-compat.mjs (100% unit-tested); the file
// read here is manual/pipeline-tested (docs/manual-test-plan.md). Used by
// sync-multicam and export-multicam-fcpxml on their audio members.
import { closeSync, openSync, readSync } from "node:fs";
import { classifyWavFcpCompat, fcpCompatWarning, parseRiffChunks } from "./wav-compat.mjs";

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

// Inspect `path` and, if it's a WAV that FCP may reject, print a warning to stderr.
// `label` names the file in the message. Returns true when a warning was emitted.
// Never throws on a read failure — a compatibility check must not break sync/export.
export function warnFcpAudioCompat(path, label = path) {
  let classification;
  try {
    classification = classifyWavFcpCompat(parseRiffChunks(readRiffHeader(path)));
  } catch {
    return false; // unreadable / not a real file → skip the advisory check
  }
  const warning = fcpCompatWarning(label, classification);
  if (warning) {
    console.warn(warning);
    return true;
  }
  return false;
}

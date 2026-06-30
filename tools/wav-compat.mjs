// Pure WAV/RIFF FCP-compatibility detection (docs/fcp-audio-compat.md, R-FA).
// Final Cut Pro's FCPXML importer rejects some WAVs that ffmpeg/QuickTime read
// fine — notably Pro Tools / Broadcast Wave files that carry a non-canonical
// (40-byte) PCM `fmt ` chunk plus extra metadata chunks (`bext`, `minf`, `elm1`,
// `regn`, `umid`, a leading `JUNK`). FCP then imports every edit referencing the
// file as "Invalid edit with no respective media" (the master audio goes silent).
// This module parses the RIFF chunk list from a byte buffer (no I/O — the header
// read lives in tools/wav-compat-io.mjs) and classifies FCP-safe vs needs-norm.
// Held to 100% coverage (vitest.config).

// A canonical PCM WAV has a 16-byte `fmt ` chunk; Pro Tools writes a 40-byte one.
export const CANONICAL_PCM_FMT_SIZE = 16;
// WAVE_FORMAT_PCM in the `fmt ` chunk's audioFormat field.
export const WAVE_FORMAT_PCM = 1;
// Non-audio metadata chunks whose presence signals a Pro Tools / BWF WAV that FCP
// may reject (compared case-insensitively against the chunk ids).
export const FCP_RISKY_CHUNKS = ["bext", "minf", "elm1", "regn", "umid", "junk"];

// The canonical re-encode that produces an FCP-safe WAV (also used in the warning).
export const WAV_NORMALIZE_HINT = "ffmpeg -fflags +bitexact -i in.wav -map_metadata -1 -c:a pcm_s16le -ac 2 -ar 48000 out.wav";

// Parse the RIFF/WAVE chunk table from the leading bytes of a file (a Uint8Array
// or Buffer). Stops at the `data` chunk (its payload is huge and irrelevant here),
// so a 64 KB header read is plenty. Returns { format: "wave"|"unknown", chunks:
// [{ id, size }], fmt: { size, audioFormat, channels, sampleRate, bitsPerSample } |
// null }. Anything that is not a RIFF/WAVE container classifies as "unknown".
export function parseRiffChunks(bytes) {
  if (bytes.byteLength < 12) return { format: "unknown", chunks: [], fmt: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (off, len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  };
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return { format: "unknown", chunks: [], fmt: null };

  const chunks = [];
  let fmt = null;
  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = ascii(off, 4);
    const size = view.getUint32(off + 4, true);
    chunks.push({ id, size });
    if (id === "fmt " && off + 8 + 16 <= view.byteLength) {
      fmt = {
        size,
        audioFormat: view.getUint16(off + 8, true),
        channels: view.getUint16(off + 10, true),
        sampleRate: view.getUint32(off + 12, true),
        bitsPerSample: view.getUint16(off + 22, true),
      };
    }
    if (id === "data") break; // the payload follows — stop before it
    off += 8 + size + (size & 1); // chunks are word-aligned (pad odd sizes)
  }
  return { format: "wave", chunks, fmt };
}

// Classify a parsed RIFF summary as FCP-safe or needing normalization. Non-WAVE
// inputs (mov/mp4 cameras, truncated reads) are reported as not-a-WAV and safe —
// this check only concerns WAV source audio. Returns { isWav, safe, reasons }.
export function classifyWavFcpCompat(summary) {
  if (!summary || summary.format !== "wave") return { isWav: false, safe: true, reasons: [] };
  const reasons = [];
  const fmt = summary.fmt;
  if (fmt && fmt.audioFormat === WAVE_FORMAT_PCM && fmt.size !== CANONICAL_PCM_FMT_SIZE) {
    reasons.push(`non-canonical PCM 'fmt ' chunk (${fmt.size} bytes; FCP expects ${CANONICAL_PCM_FMT_SIZE})`);
  }
  const risky = [...new Set(summary.chunks.map((c) => c.id.trim().toLowerCase()).filter((id) => FCP_RISKY_CHUNKS.includes(id)))];
  if (risky.length) reasons.push(`Pro Tools / BWF metadata chunks present (${risky.join(", ")})`);
  return { isWav: true, safe: reasons.length === 0, reasons };
}

// Format a human warning for a classified WAV, or null when there is nothing to
// warn about (FCP-safe, or not a WAV). `label` identifies the file in the message.
export function fcpCompatWarning(label, classification) {
  if (!classification || !classification.isWav || classification.safe) return null;
  return [
    `WARNING: ${label} may not import into Final Cut Pro.`,
    `  ${classification.reasons.join("; ")}.`,
    "  FCP loads such files as \"Invalid edit with no respective media\" (silent master audio).",
    `  Fix: re-encode to a canonical WAV, e.g.  ${WAV_NORMALIZE_HINT}`,
  ].join("\n");
}

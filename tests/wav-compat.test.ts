import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module, no types
import { classifyWavFcpCompat, fcpCompatWarning, parseRiffChunks, WAV_NORMALIZE_HINT } from "../tools/wav-compat.mjs";

// --- byte builders for synthetic WAV headers ---

function fmtBody(audioFormat: number, channels: number, sampleRate: number, bits: number, extraBytes = 0): Buffer {
  const b = Buffer.alloc(16 + extraBytes);
  b.writeUInt16LE(audioFormat, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(sampleRate, 4);
  b.writeUInt32LE((sampleRate * channels * bits) / 8, 8); // byteRate
  b.writeUInt16LE((channels * bits) / 8, 12); // blockAlign
  b.writeUInt16LE(bits, 14);
  return b;
}

function chunk(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, 4, "ascii");
  head.writeUInt32LE(body.length, 4);
  const pad = body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0); // word-align
  return Buffer.concat([head, body, pad]);
}

function riffWave(...chunkBufs: Buffer[]): Buffer {
  const body = Buffer.concat(chunkBufs);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, 4, "ascii");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WAVE", 8, 4, "ascii");
  return Buffer.concat([head, body]);
}

const data = (n = 8) => chunk("data", Buffer.alloc(n));

describe("parseRiffChunks", () => {
  it("rejects a buffer too short to hold a RIFF header", () => {
    expect(parseRiffChunks(new Uint8Array(4))).toEqual({ format: "unknown", chunks: [], fmt: null });
  });
  it("rejects a non-RIFF/WAVE container", () => {
    const buf = Buffer.from("RIFFxxxxAVI " + "x".repeat(8), "ascii"); // RIFF but not WAVE
    expect(parseRiffChunks(buf).format).toBe("unknown");
  });
  it("parses a canonical PCM WAV (16-byte fmt + data)", () => {
    const r = parseRiffChunks(riffWave(chunk("fmt ", fmtBody(1, 2, 48000, 16)), data()));
    expect(r.format).toBe("wave");
    expect(r.chunks.map((c: { id: string }) => c.id)).toEqual(["fmt ", "data"]);
    expect(r.fmt).toEqual({ size: 16, audioFormat: 1, channels: 2, sampleRate: 48000, bitsPerSample: 16 });
  });
  it("parses a Pro Tools / BWF WAV (40-byte fmt + metadata chunks), incl. odd-size padding", () => {
    const r = parseRiffChunks(riffWave(
      chunk("JUNK", Buffer.alloc(92)),
      chunk("bext", Buffer.alloc(4)),
      chunk("fmt ", fmtBody(1, 2, 48000, 16, 24)), // 40-byte fmt
      chunk("elm1", Buffer.alloc(3)), // odd size → exercises word-align padding
      chunk("minf", Buffer.alloc(16)),
      data(),
    ));
    expect(r.chunks.map((c: { id: string }) => c.id)).toEqual(["JUNK", "bext", "fmt ", "elm1", "minf", "data"]);
    expect(r.fmt.size).toBe(40);
  });
  it("stops cleanly when there is no data chunk", () => {
    const r = parseRiffChunks(riffWave(chunk("fmt ", fmtBody(1, 2, 48000, 16))));
    expect(r.format).toBe("wave");
    expect(r.chunks.map((c: { id: string }) => c.id)).toEqual(["fmt "]);
  });
  it("leaves fmt null when the header is truncated mid-fmt", () => {
    const full = riffWave(chunk("fmt ", fmtBody(1, 2, 48000, 16)), data());
    const r = parseRiffChunks(full.subarray(0, 12 + 8 + 10)); // fmt header present, body cut short
    expect(r.format).toBe("wave");
    expect(r.chunks).toEqual([{ id: "fmt ", size: 16 }]);
    expect(r.fmt).toBeNull();
  });
});

describe("classifyWavFcpCompat", () => {
  it("treats a null or non-WAVE summary as not-a-WAV and safe", () => {
    expect(classifyWavFcpCompat(null)).toEqual({ isWav: false, safe: true, reasons: [] });
    expect(classifyWavFcpCompat({ format: "unknown", chunks: [], fmt: null })).toEqual({ isWav: false, safe: true, reasons: [] });
  });
  it("passes a canonical PCM WAV", () => {
    const r = classifyWavFcpCompat(parseRiffChunks(riffWave(chunk("fmt ", fmtBody(1, 2, 48000, 16)), data())));
    expect(r).toEqual({ isWav: true, safe: true, reasons: [] });
  });
  it("flags a 40-byte PCM fmt and BWF metadata chunks", () => {
    const r = classifyWavFcpCompat(parseRiffChunks(riffWave(
      chunk("JUNK", Buffer.alloc(4)),
      chunk("bext", Buffer.alloc(4)),
      chunk("fmt ", fmtBody(1, 2, 48000, 16, 24)),
      chunk("minf", Buffer.alloc(16)),
      data(),
    )));
    expect(r.safe).toBe(false);
    expect(r.reasons[0]).toMatch(/non-canonical PCM 'fmt ' chunk \(40 bytes/);
    expect(r.reasons[1]).toMatch(/junk, bext, minf/); // de-duplicated, lower-cased
  });
  it("does not flag an extended fmt when the format is WAVE_FORMAT_EXTENSIBLE", () => {
    const r = classifyWavFcpCompat(parseRiffChunks(riffWave(chunk("fmt ", fmtBody(0xfffe, 2, 48000, 16, 24)), data())));
    expect(r).toEqual({ isWav: true, safe: true, reasons: [] });
  });
  it("flags metadata chunks even when the fmt chunk is canonical", () => {
    const r = classifyWavFcpCompat(parseRiffChunks(riffWave(chunk("fmt ", fmtBody(1, 2, 48000, 16)), chunk("bext", Buffer.alloc(4)), data())));
    expect(r.safe).toBe(false);
    expect(r.reasons).toEqual(["Pro Tools / BWF metadata chunks present (bext)"]);
  });
  it("ignores a missing fmt chunk (truncated header)", () => {
    const r = classifyWavFcpCompat({ format: "wave", chunks: [{ id: "fmt ", size: 16 }], fmt: null });
    expect(r).toEqual({ isWav: true, safe: true, reasons: [] });
  });
});

describe("fcpCompatWarning", () => {
  it("returns null for null, safe, or non-WAV classifications", () => {
    expect(fcpCompatWarning("m", null)).toBeNull();
    expect(fcpCompatWarning("m", { isWav: true, safe: true, reasons: [] })).toBeNull();
    expect(fcpCompatWarning("m", { isWav: false, safe: true, reasons: [] })).toBeNull();
  });
  it("formats a warning with the label, reasons, and the ffmpeg fix", () => {
    const w = fcpCompatWarning("byam-audio", { isWav: true, safe: false, reasons: ["a", "b"] });
    expect(w).toContain("byam-audio may not import into Final Cut Pro");
    expect(w).toContain("a; b.");
    expect(w).toContain(WAV_NORMALIZE_HINT);
  });
});

#!/usr/bin/env node
/**
 * analyze-audio-events — produce an `audio-events.json` timeline of non-speech /
 * musical events (loudness envelope, onsets, quiet/vocal/instrumental sections)
 * for a source or a synced group's master audio (docs/audio-events.md, R-AE). The
 * angle selector (docs/multicam-auto-cut.md) and the visual-saliency pass consume
 * it to make the multi-cam edit follow the music, not just speech.
 *
 * Usage:
 *   analyze-audio-events <audio-or-video> [options]
 *     --transcript <whisper.json>  whisper word-timing JSON → marks vocal sections
 *     --offset <sec>               add to transcript word times (clip→absolute; default 0)
 *     --sample-rate <hz>           mono analysis rate (default 16000)
 *     --hop <sec>                  envelope hop (default 0.05)
 *     --quiet-db <db>              quiet floor, dB below peak (default -30)
 *     --min-span <sec>             minimum section length (default 0.8)
 *     --out <audio-events.json>    output path (default ./audio-events.json)
 *
 * The pure analysis lives in ./audio-events.mjs (100% unit-tested); this is the
 * ffmpeg extraction + whisper-JSON read + file write (manual-test-plan §8).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { buildAudioEvents, rmsEnvelope, wordsFromWhisper } from "./audio-events.mjs";

function parseArgs(argv) {
  const opts = { file: undefined, transcript: undefined, offset: 0, sampleRate: 16000, hop: 0.05, quietDb: -30, minSpan: 0.8, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transcript") opts.transcript = argv[++i];
    else if (a === "--offset") opts.offset = Number(argv[++i]);
    else if (a === "--sample-rate") opts.sampleRate = Number(argv[++i]);
    else if (a === "--hop") opts.hop = Number(argv[++i]);
    else if (a === "--quiet-db") opts.quietDb = Number(argv[++i]);
    else if (a === "--min-span") opts.minSpan = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: analyze-audio-events <audio-or-video> [--transcript <whisper.json>] [--offset <sec>] [--sample-rate <hz>] [--hop <sec>] [--quiet-db <db>] [--min-span <sec>] [--out <audio-events.json>]");
      process.exit(0);
    } else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else opts.file = a;
  }
  if (!opts.file) { console.error("Error: an audio/video path is required."); process.exit(2); }
  return opts;
}

function probeDuration(path) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path]).toString();
  return parseFloat(out.trim());
}

function extractMono(path, sampleRate, tmpDir) {
  const out = join(tmpDir, "mono.f32");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", out]);
  const buf = readFileSync(out);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.file)) { console.error(`Error: not found: ${opts.file}`); process.exit(1); }

  const durationSeconds = probeDuration(opts.file);
  if (!(durationSeconds > 0)) { console.error("Error: could not read a positive duration."); process.exit(1); }

  let words = [];
  if (opts.transcript) {
    if (!existsSync(opts.transcript)) { console.error(`Error: transcript not found: ${opts.transcript}`); process.exit(1); }
    words = wordsFromWhisper(JSON.parse(readFileSync(opts.transcript, "utf8")), opts.offset);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "audio-events-"));
  try {
    const samples = extractMono(opts.file, opts.sampleRate, tmpDir);
    const envelope = rmsEnvelope(samples, { sampleRate: opts.sampleRate, hopSeconds: opts.hop });
    const doc = buildAudioEvents({
      sourcePath: resolve(opts.file),
      durationSeconds,
      sampleRate: opts.sampleRate,
      envelope,
      samples,
      words,
      opts: { quietDb: opts.quietDb, minSpanSeconds: opts.minSpan },
    });

    const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : resolve("audio-events.json");
    writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");

    const counts = doc.events.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {});
    console.log(`Wrote ${outPath}: ${doc.events.length} events over ${durationSeconds.toFixed(1)}s ${JSON.stringify(counts)}.`);
    if (!opts.transcript) console.log("(no --transcript → vocal sections not marked; energetic spans are reported as instrumental)");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();

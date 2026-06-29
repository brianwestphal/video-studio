#!/usr/bin/env node
/**
 * sync-multicam — audio-synced multi-cam grouping (docs/multicam.md). Take a set
 * of clips that cover ONE event from different cameras/recorders and time-align
 * them by their audio, emitting a group manifest (`multicam.json`) with a
 * per-member offset + confidence so a cut can switch angles over a shared
 * timeline. Audio-only inputs (external mic recorders) are treated as the sync
 * reference AND the master audio.
 *
 * Usage:
 *   sync-multicam <clip...> [options]
 *     --group-id <id>        group id (default: "group")
 *     --project-fps <n>      output fps (default: highest member fps)
 *     --sample-rate <hz>     mono analysis rate (default: 8000)
 *     --feature <envelope|raw>  correlation feature (default: envelope)
 *     --max-offset <sec>     max plausible start offset to search (default: 300)
 *     --accept <0..1>        auto-accept confidence (default: 0.8)
 *     --reject <0..1>        manual-fallback confidence (default: 0.5)
 *     --drift-min <sec>      estimate drift on clips longer than this (default: 600)
 *     --window <sec>         drift-probe window length (default: 30)
 *     --manual <id>=<sec>    force a member's offset (silent/non-overlapping audio)
 *     --out <multicam.json>  output path (default: ./multicam.json)
 *
 * All alignment is done in SECONDS via the audio sample clock, so mismatched /
 * non-integer frame rates (29.97 vs 30) need no special handling — each member
 * keeps its own fps and is conformed to the project fps on export. The pure DSP +
 * manifest math lives in ./multicam.mjs (unit-tested); this is the ffmpeg I/O.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assignSourceIds } from "./sources.mjs";
import {
  buildGroupManifest,
  classifySync,
  condition,
  findOffset,
  fitDrift,
} from "./multicam.mjs";

function parseArgs(argv) {
  const inputs = [];
  const manual = new Map();
  const opts = {
    groupId: "group",
    projectFps: undefined,
    sampleRate: 8000,
    feature: "envelope",
    maxOffset: 300,
    accept: 0.8,
    reject: 0.5,
    driftMin: 600,
    window: 30,
    out: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group-id") opts.groupId = argv[++i];
    else if (a === "--project-fps") opts.projectFps = Number(argv[++i]);
    else if (a === "--sample-rate") opts.sampleRate = Number(argv[++i]);
    else if (a === "--feature") opts.feature = argv[++i];
    else if (a === "--max-offset") opts.maxOffset = Number(argv[++i]);
    else if (a === "--accept") opts.accept = Number(argv[++i]);
    else if (a === "--reject") opts.reject = Number(argv[++i]);
    else if (a === "--drift-min") opts.driftMin = Number(argv[++i]);
    else if (a === "--window") opts.window = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--manual") {
      const [id, sec] = String(argv[++i]).split("=");
      manual.set(id, Number(sec));
    } else if (a === "-h" || a === "--help") {
      console.log("Usage: sync-multicam <clip…> [--group-id <id>] [--project-fps <n>] [--sample-rate <hz>] [--feature <envelope|raw>] [--max-offset <sec>] [--accept <0..1>] [--reject <0..1>] [--drift-min <sec>] [--window <sec>] [--manual <id>=<sec>] [--out <multicam.json>]");
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    } else inputs.push(a);
  }
  if (inputs.length < 2) {
    console.error("Error: a multicam group needs at least two clips.");
    process.exit(2);
  }
  return { inputs, manual, opts };
}

// Probe a clip: whether it has a video stream (else it is treated as audio-only),
// its frame rate, and its duration in seconds.
function probe(path) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,r_frame_rate",
    "-show_entries", "format=duration",
    "-of", "json", path,
  ]).toString();
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  let fps = null;
  if (v && v.r_frame_rate) {
    const [num, den] = v.r_frame_rate.split("/");
    fps = den ? Number(num) / Number(den) : Number(num);
  }
  return { kind: v ? "video" : "audio", fps, durationSeconds: parseFloat(j.format?.duration ?? "0") };
}

// Extract mono float32 PCM at `sampleRate` to a temp file and read it back as a
// Float32Array. ffmpeg does the decode / downmix / resample.
function extractMono(path, sampleRate, tmpDir, id) {
  const out = join(tmpDir, `${id}.f32`);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", path,
    "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", out,
  ]);
  const buf = readFileSync(out);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

// Estimate clock drift by measuring the offset on a window near the start and a
// window near the end of the clip, then fitting a line. Returns drift ppm or 0
// if the clip is too short / windows do not correlate well.
function estimateDriftPpm(refSig, clipSig, sampleRate, opts) {
  const win = Math.floor(opts.window * sampleRate);
  const maxLag = Math.floor(opts.maxOffset * sampleRate);
  if (clipSig.length < win * 2) return 0;
  const startWin = clipSig.subarray(0, win);
  const endStart = clipSig.length - win;
  const endWin = clipSig.subarray(endStart);
  const a = findOffset(refSig, startWin, { maxLagSamples: maxLag });
  const b = findOffset(refSig, endWin, { maxLagSamples: maxLag });
  if (a.confidence < opts.reject || b.confidence < opts.reject) return 0;
  const { slopePpm } = fitDrift([
    { atSeconds: win / 2 / sampleRate, offsetSeconds: a.offsetSamples / sampleRate },
    { atSeconds: (endStart + win / 2) / sampleRate, offsetSeconds: b.offsetSamples / sampleRate },
  ]);
  return slopePpm;
}

function main() {
  const { inputs, manual, opts } = parseArgs(process.argv.slice(2));
  for (const p of inputs) {
    if (!existsSync(p)) { console.error(`Error: not found: ${p}`); process.exit(1); }
  }

  const ided = assignSourceIds(inputs.map((p) => resolve(p)));
  const probed = ided.map(({ id, path }) => ({ id, path, ...probe(path) }));
  const projectFps = opts.projectFps || Math.max(...probed.map((m) => m.fps || 0)) || null;
  console.log(`Group "${opts.groupId}": ${probed.length} member(s), project fps ${projectFps ?? "?"}.`);

  // The reference is the audio-only member if there is one, else the longest.
  const audioOnly = probed.filter((m) => m.kind === "audio");
  const pool = audioOnly.length ? audioOnly : probed;
  const reference = pool.reduce((best, m) => (m.durationSeconds > best.durationSeconds ? m : best), pool[0]);
  console.log(`Reference: ${reference.id} (${reference.kind})`);

  const tmpDir = mkdtempSync(join(tmpdir(), "multicam-"));
  try {
    const signals = new Map();
    for (const m of probed) {
      console.log(`Extracting mono audio: ${m.id}…`);
      signals.set(m.id, condition(extractMono(m.path, opts.sampleRate, tmpDir, m.id), { feature: opts.feature }));
    }
    const refSig = signals.get(reference.id);
    const maxLag = Math.floor(opts.maxOffset * opts.sampleRate);

    const members = probed.map((m) => {
      if (m.id === reference.id) {
        return { ...m, offsetSeconds: 0, confidence: 1, peakRatio: null, sync: "reference", driftPpm: 0 };
      }
      if (manual.has(m.id)) {
        return { ...m, offsetSeconds: manual.get(m.id), confidence: 1, peakRatio: null, sync: "manual", driftPpm: 0 };
      }
      const sig = signals.get(m.id);
      const r = findOffset(refSig, sig, { maxLagSamples: maxLag });
      // "manual" from the gate means the correlation was too weak to trust — the
      // member is left UNSYNCED until a human supplies --manual. (An applied
      // override above is labeled "manual".)
      const cls = classifySync(r.confidence, { accept: opts.accept, reject: opts.reject });
      const sync = cls === "manual" ? "unsynced" : cls;
      const driftPpm = m.durationSeconds >= opts.driftMin ? estimateDriftPpm(refSig, sig, opts.sampleRate, opts) : 0;
      return {
        ...m,
        offsetSeconds: r.offsetSamples / opts.sampleRate,
        confidence: r.confidence,
        peakRatio: Number.isFinite(r.peakRatio) ? r.peakRatio : null,
        sync,
        driftPpm,
      };
    });

    const manifest = buildGroupManifest({ id: opts.groupId, projectFps, members });
    const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : resolve("multicam.json");
    writeFileSync(outPath, JSON.stringify({ groups: [manifest] }, null, 2) + "\n");

    console.log(`\nWrote ${outPath}.`);
    for (const m of manifest.members) {
      const conf = m.confidence === 1 ? "" : ` conf=${m.confidence.toFixed(2)}`;
      const drift = m.driftWarning ? ` DRIFT ${m.driftPpm.toFixed(0)}ppm` : "";
      console.log(`  ${m.id}: ${m.sync} offset=${m.offsetSeconds.toFixed(3)}s${conf}${drift}`);
    }
    const needManual = manifest.members.filter((m) => m.sync === "unsynced");
    if (needManual.length) {
      console.log(`\n${needManual.length} member(s) need a manual offset (weak/non-overlapping audio):`);
      for (const m of needManual) console.log(`  re-run with --manual ${m.id}=<seconds>`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();

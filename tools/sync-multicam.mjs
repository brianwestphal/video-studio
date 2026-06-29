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
 *     --feature <envelope|raw|phat>  correlation feature (default: envelope;
 *                            "phat" = GCC-PHAT phase-whitened, noise-robust)
 *     --max-offset <sec>     max plausible start offset to search (default: 300)
 *     --accept <0..1>        auto-accept confidence (default: 0.8)
 *     --reject <0..1>        manual-fallback confidence (default: 0.5)
 *     --drift-min <sec>      estimate drift on clips longer than this (default: 600)
 *     --window <sec>         drift-probe window length (default: 30)
 *     --no-interpolate       disable sub-sample (parabolic) peak refinement
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
  driftCorrection,
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
    interpolate: true,
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
    else if (a === "--no-interpolate") opts.interpolate = false;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--manual") {
      const [id, sec] = String(argv[++i]).split("=");
      manual.set(id, Number(sec));
    } else if (a === "-h" || a === "--help") {
      console.log("Usage: sync-multicam <clip…> [--group-id <id>] [--project-fps <n>] [--sample-rate <hz>] [--feature <envelope|raw|phat>] [--max-offset <sec>] [--accept <0..1>] [--reject <0..1>] [--drift-min <sec>] [--window <sec>] [--no-interpolate] [--manual <id>=<sec>] [--out <multicam.json>]");
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
// window near the end of the clip, then fitting a line. Each window is matched
// only against the REFERENCE REGION it is expected to land in (the clip window's
// position shifted by the global offset, ± a margin) — searching the whole
// reference would lock onto spurious far-away matches in repetitive audio.
// `globalOffsetSamples` is the member's whole-clip offset. Returns { slopePpm,
// startOffsetSeconds } (start-anchored offset to pair with a rate correction),
// or { slopePpm: 0 } if the clip is too short / a window doesn't correlate well.
function estimateDrift(refSig, clipSig, sampleRate, opts, findOpts, globalOffsetSamples) {
  const win = Math.floor(opts.window * sampleRate);
  if (clipSig.length < win * 2) return { slopePpm: 0 };
  // The reference is sliced to a bounded region around where the clip window is
  // expected to land (± one window), then searched in full — the slice itself is
  // the constraint, so we do NOT cap the lag (capping clipped the true peak).
  const margin = win;
  const localFind = { ...findOpts, maxLagSamples: null };

  // Offset (seconds) of the clip window starting at clip-local index `clipStart`.
  const measure = (clipStart) => {
    const cw = clipSig.subarray(clipStart, clipStart + win);
    const refCenter = Math.round(clipStart + globalOffsetSamples);
    const lo = Math.max(0, refCenter - margin);
    const hi = Math.min(refSig.length, refCenter + win + margin);
    const rw = refSig.subarray(lo, hi);
    const r = findOffset(rw, cw, localFind);
    if (r.confidence < opts.reject) return null;
    // cw[i] ~ rw[i + r.offset] = ref[lo + i + r.offset]; clip-local index is
    // clipStart + i, so offset = ref_index - clip_index = lo - clipStart + r.offset.
    return (lo - clipStart + r.offsetSamples) / sampleRate;
  };

  const endStart = clipSig.length - win;
  const o1 = measure(0);
  const o2 = measure(endStart);
  if (o1 == null || o2 == null) return { slopePpm: 0 };
  const startAt = win / 2 / sampleRate;
  const { slopePpm } = fitDrift([
    { atSeconds: startAt, offsetSeconds: o1 },
    { atSeconds: (endStart + win / 2) / sampleRate, offsetSeconds: o2 },
  ]);
  const slope = slopePpm / 1e6;
  return { slopePpm, startOffsetSeconds: o1 - slope * startAt };
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

  // "phat" is a correlation METHOD on the raw (mean-removed) waveform; "envelope"
  // / "raw" are conditioning features correlated with the standard method.
  const corrMethod = opts.feature === "phat" ? "phat" : "standard";
  const condFeature = opts.feature === "phat" ? "raw" : opts.feature;

  const tmpDir = mkdtempSync(join(tmpdir(), "multicam-"));
  try {
    const signals = new Map();
    for (const m of probed) {
      console.log(`Extracting mono audio: ${m.id}…`);
      signals.set(m.id, condition(extractMono(m.path, opts.sampleRate, tmpDir, m.id), { feature: condFeature }));
    }
    const refSig = signals.get(reference.id);
    const maxLag = Math.floor(opts.maxOffset * opts.sampleRate);
    const findOpts = { maxLagSamples: maxLag, method: corrMethod, interpolate: opts.interpolate };

    const members = probed.map((m) => {
      if (m.id === reference.id) {
        return { ...m, offsetSeconds: 0, confidence: 1, peakRatio: null, sync: "reference", driftPpm: 0 };
      }
      if (manual.has(m.id)) {
        return { ...m, offsetSeconds: manual.get(m.id), confidence: 1, peakRatio: null, sync: "manual", driftPpm: 0 };
      }
      const sig = signals.get(m.id);
      const r = findOffset(refSig, sig, findOpts);
      // "manual" from the gate means the correlation was too weak to trust — the
      // member is left UNSYNCED until a human supplies --manual. (An applied
      // override above is labeled "manual".)
      const cls = classifySync(r.confidence, { accept: opts.accept, reject: opts.reject });
      const sync = cls === "manual" ? "unsynced" : cls;
      const drift = m.durationSeconds >= opts.driftMin ? estimateDrift(refSig, sig, opts.sampleRate, opts, findOpts, r.offsetSamples) : { slopePpm: 0 };
      const { rate } = driftCorrection(drift.slopePpm);
      return {
        ...m,
        offsetSeconds: r.offsetSamples / opts.sampleRate,
        confidence: r.confidence,
        peakRatio: Number.isFinite(r.peakRatio) ? r.peakRatio : null,
        sync,
        driftPpm: drift.slopePpm,
        rateCorrection: rate,
        correctedOffsetSeconds: drift.slopePpm !== 0 ? drift.startOffsetSeconds : null,
      };
    });

    const manifest = buildGroupManifest({ id: opts.groupId, projectFps, members });
    const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : resolve("multicam.json");
    writeFileSync(outPath, JSON.stringify({ groups: [manifest] }, null, 2) + "\n");

    console.log(`\nWrote ${outPath}.`);
    for (const m of manifest.members) {
      const conf = m.confidence === 1 ? "" : ` conf=${m.confidence.toFixed(2)}`;
      const drift = m.driftWarning ? ` DRIFT ${m.driftPpm.toFixed(0)}ppm → rate×${m.rateCorrection.toFixed(6)}` : "";
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

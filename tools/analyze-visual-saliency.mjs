#!/usr/bin/env node
/**
 * analyze-visual-saliency — per-angle visual saliency for a synced multicam group
 * (docs/visual-saliency.md, R-VS; VS-45). For each video angle it scores aligned
 * windows on the group clock: a cheap motion pass (every window) gates the costly
 * Ollama vision calls (sampled at section boundaries / high-motion windows), and
 * the result is written to `saliency.json` for the angle selector (VS-46).
 *
 * Usage:
 *   analyze-visual-saliency <multicam.json> [options]
 *     --group <id>            group id (default: first group)
 *     --window <sec>          window length (default 2.0)
 *     --audio-events <path>   audio-events.json — gate vision toward its sections
 *     --mode motion|vision|grid   vision strategy (default vision)
 *     --cap <n>               max vision calls per angle (default 120)
 *     --motion-scale <n>      raw diff magnitude mapping to motion=1 (default 8)
 *     --model <name>          Ollama vision model (default gemma4:12b)
 *     --total <sec>           group-clock length (default: master audio duration)
 *     --out <path>            output (default <multicam dir>/saliency.json)
 *
 * Pure logic (windowing, group-clock mapping, motion normalization, vision-reply
 * parsing, gating, schema) is in ./visual-saliency.mjs (100% unit-tested); this is
 * the ffmpeg frame/motion extraction + Ollama calls (manual-test-plan §11).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import ollama from "ollama";
import {
  angleCoversWindow,
  assembleWindowScore,
  buildSaliency,
  buildWindows,
  DEFAULT_MOTION_SCALE,
  normalizeMotion,
  parseVisionReply,
  sectionBoundaries,
  selectVisionWindows,
  sourceTime,
  visionPrompt,
} from "./visual-saliency.mjs";

function parseArgs(argv) {
  const o = { file: undefined, group: undefined, window: 2.0, audioEvents: undefined, mode: "vision", cap: 120, motionScale: DEFAULT_MOTION_SCALE, model: "gemma4:12b", total: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group") o.group = argv[++i];
    else if (a === "--window") o.window = Number(argv[++i]);
    else if (a === "--audio-events") o.audioEvents = argv[++i];
    else if (a === "--mode") o.mode = argv[++i];
    else if (a === "--cap") o.cap = Number(argv[++i]);
    else if (a === "--motion-scale") o.motionScale = Number(argv[++i]);
    else if (a === "--model") o.model = argv[++i];
    else if (a === "--total") o.total = Number(argv[++i]);
    else if (a === "--out") o.out = argv[++i];
    else if (a === "-h" || a === "--help") { console.log("Usage: analyze-visual-saliency <multicam.json> [--group id] [--window sec] [--audio-events path] [--mode motion|vision|grid] [--cap n] [--motion-scale n] [--model name] [--total sec] [--out path]"); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else o.file = a;
  }
  if (!o.file) { console.error("Error: a multicam.json path is required."); process.exit(2); }
  if (!["motion", "vision", "grid"].includes(o.mode)) { console.error(`Error: --mode must be motion|vision|grid (got ${o.mode}).`); process.exit(2); }
  return o;
}

// One ffmpeg pass per angle: downscale + 2fps + frame-difference + signalstats,
// printing the average luma of each difference frame (the motion magnitude). Returns
// [{ sourceSeconds, value }] in the angle's own media time.
function motionSamples(path, tmp, maxSeconds) {
  const out = join(tmp, "motion.txt");
  const limit = maxSeconds && maxSeconds > 0 ? ["-t", String(maxSeconds)] : [];
  execFileSync("ffmpeg", ["-nostats", "-loglevel", "error", "-i", path, ...limit,
    "-vf", `scale=64:36,fps=2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=${out}`,
    "-an", "-f", "null", "-"]);
  const samples = [];
  let t = null;
  for (const line of readFileSync(out, "utf8").split("\n")) {
    const mt = line.match(/pts_time:([\d.]+)/);
    if (mt) { t = Number(mt[1]); continue; }
    const mv = line.match(/YAVG=([\d.]+)/);
    if (mv && t != null) samples.push({ sourceSeconds: t, value: Number(mv[1]) });
  }
  return samples;
}

// Average motion magnitude over a window for one angle, from its motion samples
// (mapped group→source). Returns 0 when no samples fall in the window.
function windowMotion(window, member, samples) {
  const inLo = sourceTime(window.startSeconds, member);
  const inHi = sourceTime(window.endSeconds, member);
  const lo = Math.min(inLo, inHi);
  const hi = Math.max(inLo, inHi);
  let sum = 0;
  let n = 0;
  for (const s of samples) if (s.sourceSeconds >= lo && s.sourceSeconds < hi) { sum += s.value; n++; }
  return n > 0 ? sum / n : 0;
}

function extractFrame(path, sourceSeconds, tmp, idx) {
  const out = join(tmp, `f${idx}.jpg`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, sourceSeconds)), "-i", path, "-frames:v", "1", "-q:v", "3", "-vf", "scale=512:-2", out]);
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.file)) { console.error(`Error: not found: ${opts.file}`); process.exit(1); }
  const doc = JSON.parse(readFileSync(opts.file, "utf8"));
  const groups = doc.groups || [doc];
  const group = opts.group ? groups.find((g) => g.id === opts.group) : groups[0];
  if (!group) { console.error(`Error: group not found: ${opts.group}`); process.exit(1); }

  const videos = (group.members || []).filter((m) => m.kind === "video");
  if (videos.length === 0) { console.error("Error: the group has no video angles."); process.exit(1); }
  const master = (group.members || []).find((m) => m.id === group.masterAudioId);
  const total = opts.total ?? master?.durationSeconds ?? Math.max(...videos.map((m) => m.durationSeconds || 0));
  if (!(total > 0)) { console.error("Error: could not determine the group-clock length (pass --total)."); process.exit(1); }

  const windows = buildWindows(total, opts.window);
  const boundaries = opts.audioEvents && existsSync(opts.audioEvents)
    ? sectionBoundaries(JSON.parse(readFileSync(opts.audioEvents, "utf8")))
    : [];

  const angles = {};
  let totalVision = 0;
  let totalSkipped = 0;
  for (const member of videos) {
    const tmp = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      // Decode only as far into this angle as the group clock needs (+1 window slack).
      const maxSrc = sourceTime(total, member) + opts.window;
      const samples = motionSamples(member.path, tmp, maxSrc); // cheap pass; gates vision and scores motion
      // Covered windows + their motion (aligned to the full window grid by index).
      const covered = windows.map((w) => angleCoversWindow(w, member));
      const motion = windows.map((w, i) => (covered[i] ? normalizeMotion(windowMotion(w, member, samples), opts.motionScale) : 0));
      // Gate vision to covered windows only.
      const selectable = selectVisionWindows(windows, { mode: opts.mode, motion, boundaries, cap: opts.cap });
      const visionSet = new Set(selectable.filter((i) => covered[i]));

      const entries = [];
      for (let i = 0; i < windows.length; i++) {
        if (!covered[i]) continue;
        const w = windows[i];
        if (visionSet.has(i)) {
          const center = (w.startSeconds + w.endSeconds) / 2;
          const frame = extractFrame(member.path, sourceTime(center, member), tmp, i);
          const reply = await ollama.chat({ model: opts.model, messages: [{ role: "user", content: visionPrompt(), images: [readFileSync(frame).toString("base64")] }] });
          const parsed = parseVisionReply(reply.message.content);
          entries.push(assembleWindowScore({ window: w, scores: { ...parsed.scores, motion: motion[i] }, labels: parsed.labels, confidence: parsed.confidence, source: "vision" }));
          totalVision++;
        } else {
          entries.push(assembleWindowScore({ window: w, scores: { motion: motion[i] }, source: "motion" }));
          totalSkipped++;
        }
      }
      angles[member.id] = entries;
      console.log(`  ${member.id}: ${entries.length} window(s) — ${[...visionSet].length} vision, ${entries.length - [...visionSet].length} motion-only`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const saliency = buildSaliency({ groupId: group.id, windowSeconds: opts.window, angles });
  const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : join(dirname(resolve(opts.file)), "saliency.json");
  writeFileSync(outPath, JSON.stringify(saliency, null, 2) + "\n");
  console.log(`Wrote ${outPath}: ${videos.length} angle(s), ${windows.length} window(s) @ ${opts.window}s, ${totalVision} vision call(s), ${totalSkipped} motion-only (mode=${opts.mode}).`);
}

main().catch((err) => { console.error(err); process.exit(1); });

#!/usr/bin/env node
/**
 * render-transitions — bake the cut spec's `transitions` into a finished video via
 * ffmpeg, with NO Final Cut Pro required (docs/render-transitions.md, VS-54/55).
 * Reads an editor-handoff export's `manifest.json` (its `segments` carry the baked
 * transition handles + the `transitions` list) and renders a single output,
 * dissolving/wiping/sliding/insetting through each cut using the handle material.
 *
 * Usage:
 *   render-transitions <manifest.json> [--out <file.mov>] [--full-chain]
 *
 * Two render strategies:
 *   - windowed (default): re-encode only the short overlap at each transition and
 *     stream-copy-concat the rest, so cost ≈ Σ(transition duration). Renders
 *     native Tier-B/C transitions (chevron/static/inset/split). (R-RT1–R-RT4)
 *   - --full-chain: the original single `xfade`/`acrossfade` graph over the whole
 *     timeline (re-encodes everything; Tier B/C degrade to the nearest xfade look).
 *     Kept for comparison / as a fallback.
 *
 * The pure plans + recipe maps + filtergraph assembly live in
 * ./transitions-render.mjs (100% unit-tested); this is the ffmpeg run + concat +
 * master-audio mux (manual-test-plan §10). The FCPXML suggestion path is unaffected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildTransitionRenderPlan,
  buildWindowedRenderPlan,
  transitionFilterComplex,
  windowedClipFilter,
} from "./transitions-render.mjs";

function parseArgs(argv) {
  const opts = { file: undefined, out: undefined, fullChain: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--full-chain") opts.fullChain = true;
    else if (a === "-h" || a === "--help") {
      console.log("Usage: render-transitions <manifest.json> [--out <file.mov>] [--full-chain]");
      process.exit(0);
    } else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else opts.file = a;
  }
  if (!opts.file) { console.error("Error: a manifest.json path is required."); process.exit(2); }
  return opts;
}

// Shared ProRes 422 (HQ) video + PCM audio encode settings.
const V_ENC = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"];
const A_ENC = ["-c:a", "pcm_s16le", "-ar", "48000"];

function ff(args) {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
}

// Does this file carry an audio stream? (Multicam angle exports may be video-only.)
function hasAudioStream(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

// --- Windowed render: re-encode only the transition clips; concat the segment ---
// "bodies" straight from source via the concat demuxer's frame-exact inpoint/
// outpoint (all-intra ProRes), so cost ≈ Σ(transition duration). The bodies are
// never re-encoded or even rewritten — only the short overlap clips are. (R-RT1–4)
function renderWindowed(manifest, dir, outPath, fps) {
  const plan = buildWindowedRenderPlan(manifest.segments, manifest.transitions, { audioTrack: !!manifest.audioTrack });
  // The concat needs one consistent stream layout: render clip audio iff the
  // source segments carry audio. When a continuous master track is present, that
  // concat audio is replaced by the master in the mux step below.
  const firstBody = plan.bodies.find((b) => b.durationSeconds > 0) || plan.bodies[0];
  const clipAudio = hasAudioStream(join(dir, firstBody.file)) ? "crossfade" : "continuous";

  const tmp = [];
  const lines = [];
  const q = (p) => `file '${p.replace(/'/g, "'\\''")}'`;
  for (let j = 0; j < plan.bodies.length; j++) {
    const body = plan.bodies[j];
    if (body.durationSeconds > 0) {
      lines.push(q(body.file), `inpoint ${body.trimStart}`, `outpoint ${+(body.trimStart + body.durationSeconds).toFixed(3)}`);
    }
    const clip = plan.clips[j]; // undefined past the last body; null at a hard cut
    if (clip) {
      const clipName = `.tr-clip-${j}.mov`;
      const fc = windowedClipFilter(clip.recipe, { durationSeconds: clip.durationSeconds, audio: clipAudio });
      const args = [
        "-ss", String(clip.left.trimStart), "-t", String(clip.left.durationSeconds), "-i", join(dir, clip.left.file),
        "-ss", String(clip.right.trimStart), "-t", String(clip.right.durationSeconds), "-i", join(dir, clip.right.file),
        "-filter_complex", fc.filter, "-map", `[${fc.vOut}]`,
      ];
      if (fc.aOut) args.push("-map", `[${fc.aOut}]`);
      args.push(...V_ENC, "-r", String(fps), ...(fc.aOut ? A_ENC : []), join(dir, clipName));
      ff(args);
      tmp.push(join(dir, clipName));
      lines.push(q(clipName));
    }
  }

  // Concat segment bodies (copied via inpoint/outpoint) + the transition clips.
  const listPath = join(dir, ".tr-concat.txt");
  writeFileSync(listPath, lines.join("\n") + "\n");
  tmp.push(listPath);
  const videoOnly = plan.audio === "continuous"; // master audio is muxed separately
  const stage = videoOnly ? join(dir, ".tr-staged.mov") : outPath;
  ff(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", stage]);
  if (videoOnly) {
    tmp.push(stage);
    ff(["-i", stage, "-i", join(dir, manifest.audioTrack.file), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...A_ENC, "-shortest", outPath]);
  }
  for (const f of tmp) rmSync(f, { force: true });

  const tiers = plan.clips.reduce((m, c) => (c ? ((m[c.tier] = (m[c.tier] || 0) + 1), m) : m), {});
  const hard = plan.clips.filter((c) => c === null).length;
  return { totalSeconds: plan.totalSeconds, segments: plan.bodies.length, tiers, hard };
}

// --- Full-chain render: one xfade/acrossfade graph over the whole timeline -------
function renderFullChain(manifest, dir, outPath, fps) {
  const plan = buildTransitionRenderPlan(manifest.segments, manifest.transitions, { audioTrack: !!manifest.audioTrack });
  const fc = transitionFilterComplex(plan);
  const args = [];
  for (const inp of plan.inputs) args.push("-ss", String(inp.trimStart), "-t", String(inp.durationSeconds), "-i", join(dir, inp.file));
  args.push("-filter_complex", fc.filter, "-map", `[${fc.vOut}]`);
  const videoOnly = plan.audio === "continuous";
  const stage = videoOnly ? join(dir, ".tr-staged.mov") : outPath;
  if (fc.aOut) args.push("-map", `[${fc.aOut}]`);
  args.push(...V_ENC, "-r", String(fps), ...A_ENC, stage);
  ff(args);
  if (videoOnly) {
    ff(["-i", stage, "-i", join(dir, manifest.audioTrack.file), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", ...A_ENC, "-shortest", outPath]);
    rmSync(stage, { force: true });
  }
  const kinds = plan.joins.reduce((m, j) => ((m[j.kind] = (m[j.kind] || 0) + 1), m), {});
  return { totalSeconds: plan.totalSeconds, segments: plan.inputs.length, kinds };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.file)) { console.error(`Error: not found: ${opts.file}`); process.exit(1); }
  const manifest = JSON.parse(readFileSync(opts.file, "utf8"));
  const transitions = manifest.transitions || [];
  if (transitions.length === 0) {
    console.error("Error: this manifest has no `transitions` — export with transitions to render them. (Plain cuts: use rebuild.sh.)");
    process.exit(1);
  }

  const dir = dirname(resolve(opts.file));
  const project = manifest.project || {};
  const fps = project.fps;
  const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : join(dir, `${project.name || "transitions"}.transitions.mov`);

  if (opts.fullChain) {
    const r = renderFullChain(manifest, dir, outPath, fps);
    console.log(`Wrote ${outPath} (full-chain): ${r.totalSeconds.toFixed(2)}s, ${r.segments} segment(s), ${JSON.stringify(r.kinds)} join(s).`);
  } else {
    const r = renderWindowed(manifest, dir, outPath, fps);
    console.log(`Wrote ${outPath} (windowed): ${r.totalSeconds.toFixed(2)}s, ${r.segments} segment(s), ${r.hard} hard cut(s), tiers ${JSON.stringify(r.tiers)}.`);
  }
}

main();

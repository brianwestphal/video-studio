#!/usr/bin/env node
/**
 * render-transitions — bake the cut spec's `transitions` into a finished video via
 * ffmpeg `xfade`/`acrossfade`, with NO Final Cut Pro required (docs/transitions.md
 * §8, VS-54). Reads an editor-handoff export's `manifest.json` (its `segments` carry
 * the baked transition handles + the `transitions` list) and renders a single
 * output, dissolving/wiping/sliding through each cut using the handle material.
 *
 * Usage:
 *   render-transitions <manifest.json> [--out <file.mov>]
 *
 * The pure plan + `xfade` mapping/arithmetic + `-filter_complex` assembly live in
 * ./transitions-render.mjs (100% unit-tested); this is the ffmpeg run + master-audio
 * mux (manual-test-plan §10). The FCPXML transition-suggestion path is unaffected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildTransitionRenderPlan, transitionFilterComplex } from "./transitions-render.mjs";

function parseArgs(argv) {
  const opts = { file: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: render-transitions <manifest.json> [--out <file.mov>]");
      process.exit(0);
    } else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else opts.file = a;
  }
  if (!opts.file) { console.error("Error: a manifest.json path is required."); process.exit(2); }
  return opts;
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
  const plan = buildTransitionRenderPlan(manifest.segments, transitions, { audioTrack: !!manifest.audioTrack });
  const fc = transitionFilterComplex(plan);

  const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : join(dir, `${project.name || "transitions"}.transitions.mov`);

  // One ffmpeg run: each segment trimmed to its piece, chained through the graph.
  const args = ["-y", "-loglevel", "error"];
  for (const inp of plan.inputs) args.push("-ss", String(inp.trimStart), "-t", String(inp.durationSeconds), "-i", join(dir, inp.file));
  args.push("-filter_complex", fc.filter, "-map", `[${fc.vOut}]`);
  const videoOnly = plan.audio === "continuous"; // master audio is muxed separately below
  const stage = videoOnly ? join(dir, ".transitions.video.mov") : outPath;
  if (fc.aOut) args.push("-map", `[${fc.aOut}]`);
  args.push("-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le", "-r", String(project.fps), "-c:a", "pcm_s16le", "-ar", "48000", stage);
  execFileSync("ffmpeg", args);

  if (videoOnly) {
    // Mux the continuous master audio under the transitioned video (multicam case).
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", stage, "-i", join(dir, manifest.audioTrack.file),
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "pcm_s16le", "-shortest", outPath]);
    rmSync(stage, { force: true });
  }

  const kinds = plan.joins.reduce((m, j) => ((m[j.kind] = (m[j.kind] || 0) + 1), m), {});
  console.log(`Wrote ${outPath}: ${plan.totalSeconds.toFixed(2)}s, ${plan.inputs.length} segment(s), ${JSON.stringify(kinds)} join(s).`);
}

main();

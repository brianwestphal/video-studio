#!/usr/bin/env node
/**
 * export-project — editor handoff (docs/editor-handoff.md). Turn a cut spec into
 * a project folder of edit-grade pieces for finishing in an NLE (Final Cut Pro):
 *   <out>/
 *     segments/  seg-001.mov …   ProRes 422 HQ, frame-accurate, in cut order
 *     overlays/  ov-001.mov  …   ProRes 4444 (alpha)
 *     manifest.json                machine-readable target time ranges
 *     rebuild.sh                   re-composites the exact final cut
 *
 * Usage:
 *   export-project <cut-spec.json> [--out <dir>]
 *
 * Cut spec shape:
 *   {
 *     "project": { "fps": 24, "width": 1920, "height": 1080, "name": "teaser" },
 *     "clips":   [ { "source": "/abs/a.mov", "in": 36.18, "out": 39.20, "audio": "keep" }, … ],
 *     "overlays":[ { "file": "/abs/cap.mov", "overClip": 0, "atOffset": 0.5, "position": "lower-third" }, … ]
 *   }
 * FCPXML generation is a separate tool (see docs/editor-handoff.md §6).
 *
 * The manifest/command logic lives in ./export-manifest.mjs (unit-tested); this
 * file is the I/O: probing overlay durations and running ffmpeg.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { audioTrackArgs, buildManifest, overlayArgs, rebuildScript, segmentArgs } from "./export-manifest.mjs";
import { buildFcpxml } from "./fcpxml.mjs";

function parseArgs(argv) {
  let spec, out;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i];
    else if (a === "-h" || a === "--help") { console.log("Usage: export-project <cut-spec.json> [--out <dir>]"); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else if (!spec) spec = a;
    else { console.error(`Unexpected argument: ${a}`); process.exit(2); }
  }
  if (!spec) { console.error("Error: a cut-spec JSON path is required."); process.exit(2); }
  return { spec, out };
}

function ffprobeDuration(file) {
  const s = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file]).toString().trim();
  return parseFloat(s);
}

function ffmpeg(args) {
  execFileSync("ffmpeg", ["-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
}

function main() {
  const { spec: specPath, out } = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const specDir = dirname(resolve(specPath));
  const abs = (p) => (isAbsolute(p) ? p : resolve(specDir, p));

  // Resolve source paths relative to the spec file for portability.
  for (const c of spec.clips || []) c.source = abs(c.source);
  for (const o of spec.overlays || []) o.file = abs(o.file);
  if (spec.audioTrack) spec.audioTrack.source = abs(spec.audioTrack.source);

  const overlayDurations = (spec.overlays || []).map((o) => o.duration ?? ffprobeDuration(o.file));
  const manifest = buildManifest(spec, overlayDurations);

  const outDir = resolve(out || `${manifest.project.name}.studio-export`);
  mkdirSync(resolve(outDir, "segments"), { recursive: true });
  if (manifest.overlays.length) mkdirSync(resolve(outDir, "overlays"), { recursive: true });

  console.log(`Exporting ${manifest.segments.length} segment(s) + ${manifest.overlays.length} overlay(s) → ${outDir}`);
  manifest.segments.forEach((s, i) => {
    console.log(`  segment ${s.index}: ${s.target.start.timecode} → ${s.target.end.timecode}`);
    ffmpeg(segmentArgs(manifest.project, spec.clips[i], resolve(outDir, s.file)));
  });
  manifest.overlays.forEach((o, i) => {
    console.log(`  overlay ${o.index} over seg ${o.overSegment}: ${o.target.start.timecode} → ${o.target.end.timecode}`);
    ffmpeg(overlayArgs(manifest.project, spec.overlays[i].file, o.durationSeconds, resolve(outDir, o.file)));
  });

  if (manifest.audioTrack) {
    mkdirSync(resolve(outDir, "audio"), { recursive: true });
    console.log(`  master audio: ${manifest.audioTrack.durationSeconds}s from ${manifest.audioTrack.source}`);
    ffmpeg(audioTrackArgs(manifest.audioTrack, resolve(outDir, manifest.audioTrack.file)));
  }

  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const rb = resolve(outDir, "rebuild.sh");
  writeFileSync(rb, rebuildScript(manifest));
  chmodSync(rb, 0o755);

  // Final Cut Pro X import: file:// URLs to the exported pieces in this folder.
  const fcpxml = buildFcpxml(manifest, (file) => pathToFileURL(resolve(outDir, file)).href);
  writeFileSync(resolve(outDir, `${manifest.project.name}.fcpxml`), fcpxml);

  console.log(`\nWrote manifest.json + rebuild.sh + ${manifest.project.name}.fcpxml. Final cut length: ${manifest.project.totalTimecode}.`);
  console.log(`Import the .fcpxml into Final Cut Pro, or run ${outDir}/rebuild.sh to re-composite the exact cut.`);
}

main();

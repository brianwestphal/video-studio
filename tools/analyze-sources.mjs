#!/usr/bin/env node
/**
 * analyze-sources — multiple-source input (docs/multiple-sources.md). Take any
 * mix of video files and folders, analyze each source independently with the
 * scene analyzer, and write a combined `sources.json` that indexes every source
 * (id, path, fps, duration, size) and the union of detected scenes, each tagged
 * with its sourceId. A cut can then draw segments from any source.
 *
 * Usage:
 *   analyze-sources <file-or-folder> [more…] [--data-dir <dir>] [--out <sources.json>] [--describe <none|ollama>]
 *
 * Folders are recursed for known video extensions (sorted, path-deduped). Each
 * source is analyzed into <data-dir>/<id>/ (resumable per source). The pure
 * id/manifest logic lives in ./sources.mjs (unit-tested); this is the I/O.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignSourceIds, buildSourcesManifest, isVideoFile } from "./sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANALYZER = join(ROOT, "dist", "analyzer.js");

function parseArgs(argv) {
  const inputs = [];
  let dataDir = "./analysis-data", out, describe;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir") dataDir = argv[++i];
    else if (a === "--out") out = argv[++i];
    else if (a === "--describe") describe = argv[++i];
    else if (a === "-h" || a === "--help") { console.log("Usage: analyze-sources <file-or-folder>… [--data-dir <dir>] [--out <sources.json>] [--describe <none|ollama>]"); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else inputs.push(a);
  }
  if (inputs.length === 0) { console.error("Error: at least one file or folder is required."); process.exit(2); }
  return { inputs, dataDir, out, describe };
}

// Expand inputs into a sorted, de-duplicated list of video file paths.
function expandInputs(inputs) {
  const found = new Set();
  const walk = (p) => {
    const abs = resolve(p);
    if (!existsSync(abs)) { console.warn(`Warning: not found, skipping: ${p}`); return; }
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(join(abs, name));
    } else if (isVideoFile(abs)) {
      found.add(abs);
    }
  };
  for (const i of inputs) walk(i);
  return [...found].sort();
}

function probe(file) {
  const [w, h, rate, dur] = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate", "-show_entries", "format=duration",
    "-of", "default=nk=1:nw=1", file,
  ]).toString().trim().split("\n");
  const [num, den] = rate.split("/");
  return { width: +w, height: +h, fps: den ? +num / +den : +num, durationSeconds: parseFloat(dur) };
}

function main() {
  const { inputs, dataDir, out, describe } = parseArgs(process.argv.slice(2));
  if (!existsSync(ANALYZER)) { console.error(`Analyzer not built (${ANALYZER}). Run \`npm run build\` first.`); process.exit(1); }

  const files = expandInputs(inputs);
  if (files.length === 0) { console.error("Error: no video files found in the given inputs."); process.exit(2); }
  const sources = assignSourceIds(files);
  console.log(`Found ${sources.length} source(s).`);

  const perSource = sources.map(({ id, path }, i) => {
    const srcData = resolve(dataDir, id);
    mkdirSync(srcData, { recursive: true });
    console.log(`\n[${i + 1}/${sources.length}] ${id} — ${path}`);
    const args = [ANALYZER, path, srcData, "--out", join(srcData, "timeline.json")];
    if (describe) args.push("--describe", describe);
    execFileSync("node", args, { stdio: ["ignore", "inherit", "inherit"] });
    const scenes = JSON.parse(readFileSync(join(srcData, "timeline.json"), "utf8"));
    return { id, path, ...probe(path), scenes };
  });

  const manifest = buildSourcesManifest(perSource);
  const outPath = out ? (isAbsolute(out) ? out : resolve(out)) : resolve(dataDir, "sources.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`\nWrote ${outPath}: ${manifest.sources.length} source(s), ${manifest.scenes.length} scene(s) total.`);
}

main();

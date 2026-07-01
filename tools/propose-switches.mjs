#!/usr/bin/env node
/**
 * propose-switches — auto multi-cam angle selection (docs/multicam-auto-cut.md,
 * R-AC; VS-46). Reads a synced group (multicam.json) + audio-events.json (VS-44) +
 * saliency.json (VS-45) and writes a `switches` list (+ rationale) that drops
 * straight into export-multicam-fcpxml / render-multicam-preview. The maintainer can
 * hand-edit the switches afterward (VS-47 wires the override into the workflow).
 *
 * Usage:
 *   propose-switches <multicam.json> [options]
 *     --audio-events <path>   audio-events.json (riff/vocal priors + onset snapping)
 *     --saliency <path>       saliency.json (per-angle visual scores)
 *     --group <id>            group id (default: first group)
 *     --min-shot <sec>        minimum shot length (default 2.0)
 *     --max-shot <sec>        maximum shot length / force variety (default 12)
 *     --snap <sec>            cut-on-onset snap tolerance (default 0.4)
 *     --start <sec>           trim start (first switch time; default 0)
 *     --eval                  also print the quantitative metrics (docs §6)
 *     --out <path>            output (default <multicam dir>/switches.json)
 *
 * The selection model + metrics are pure in ./multicam-autocut.mjs (100% tested);
 * this is only file I/O + arg parsing.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { autoCut, evaluate } from "./multicam-autocut.mjs";

function parseArgs(argv) {
  const o = { file: undefined, audioEvents: undefined, saliency: undefined, group: undefined, out: undefined, eval: false, params: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--audio-events") o.audioEvents = argv[++i];
    else if (a === "--saliency") o.saliency = argv[++i];
    else if (a === "--group") o.group = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--eval") o.eval = true;
    else if (a === "--min-shot") o.params.minShotSeconds = Number(argv[++i]);
    else if (a === "--max-shot") o.params.maxShotSeconds = Number(argv[++i]);
    else if (a === "--snap") o.params.snapToleranceSeconds = Number(argv[++i]);
    else if (a === "--start") o.params.startSeconds = Number(argv[++i]);
    else if (a === "-h" || a === "--help") { console.log("Usage: propose-switches <multicam.json> [--audio-events p] [--saliency p] [--group id] [--min-shot s] [--max-shot s] [--snap s] [--start s] [--eval] [--out p]"); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else o.file = a;
  }
  if (!o.file) { console.error("Error: a multicam.json path is required."); process.exit(2); }
  return o;
}

const readJson = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.file)) { console.error(`Error: not found: ${opts.file}`); process.exit(1); }
  const doc = JSON.parse(readFileSync(opts.file, "utf8"));
  const groups = doc.groups || [doc];
  const group = opts.group ? groups.find((g) => g.id === opts.group) : groups[0];
  if (!group) { console.error(`Error: group not found: ${opts.group}`); process.exit(1); }

  const audioEvents = readJson(opts.audioEvents);
  const saliency = readJson(opts.saliency);
  if (!audioEvents) console.warn("Note: no --audio-events — riff/vocal priors + onset snapping disabled.");
  if (!saliency) console.warn("Note: no --saliency — falling back to footage-based round-robin (R-AC5).");

  const result = autoCut({ group, audioEvents, saliency, params: opts.params });
  const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : join(dirname(resolve(opts.file)), "switches.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${outPath}: ${result.switches.length} switch(es) over group "${group.id}".`);

  if (opts.eval) {
    const m = evaluate({ group, audioEvents, saliency, switches: result.switches });
    console.log("Evaluation:", JSON.stringify(m, null, 2));
  }
}

main();

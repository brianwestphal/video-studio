#!/usr/bin/env node
/**
 * export-multicam-fcpxml — emit a Final Cut Pro **multicam** FCPXML from a synced
 * group (docs/multicam.md R-MC6). Unlike the flat export, this references the
 * ORIGINAL member media and produces a live `<mc-clip>` multicam clip the user
 * can re-cut in FCP's angle viewer. The synced flat-timeline export
 * (export-project + expandMulticamGroup) remains the default; this is the
 * advanced, FCP-only path.
 *
 * Usage:
 *   export-multicam-fcpxml <multicam.json> --width <w> --height <h> [options]
 *     --group <id>            which group in the file (default: the first)
 *     --switch <sec>=<id>     an angle switch point (repeatable); omit for one
 *                             span on the first video angle
 *     --name <name>           project/clip name (default: the group id)
 *     --total <sec>           timeline length (default: master audio duration)
 *     --out <file.fcpxml>     output path (default: <name>.multicam.fcpxml)
 *
 * NOTE: FCPXML multicam is intricate; validate the output by importing it into
 * Final Cut Pro (see docs/manual-test-plan.md). The XML generation in
 * ./fcpxml.mjs is unit-tested; this is the I/O.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMulticamFcpxml } from "./fcpxml.mjs";

function parseArgs(argv) {
  const opts = { file: undefined, group: undefined, name: undefined, total: undefined, width: undefined, height: undefined, out: undefined, switches: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group") opts.group = argv[++i];
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--total") opts.total = Number(argv[++i]);
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--switch") {
      const [sec, id] = String(argv[++i]).split("=");
      opts.switches.push({ atSeconds: Number(sec), memberId: id });
    } else if (a === "-h" || a === "--help") {
      console.log("Usage: export-multicam-fcpxml <multicam.json> --width <w> --height <h> [--group <id>] [--switch <sec>=<id>]… [--name <name>] [--total <sec>] [--out <file.fcpxml>]");
      process.exit(0);
    } else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else opts.file = a;
  }
  if (!opts.file) { console.error("Error: a multicam.json path is required."); process.exit(2); }
  if (!(opts.width > 0) || !(opts.height > 0)) { console.error("Error: --width and --height are required."); process.exit(2); }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = JSON.parse(readFileSync(opts.file, "utf8"));
  const groups = doc.groups || [];
  const group = opts.group ? groups.find((g) => g.id === opts.group) : groups[0];
  if (!group) { console.error(opts.group ? `Error: group not found: ${opts.group}` : "Error: no groups in the file."); process.exit(1); }

  const name = opts.name || group.id;
  const xml = buildMulticamFcpxml(
    group,
    opts.switches,
    { name, width: opts.width, height: opts.height, totalSeconds: opts.total },
    (p) => pathToFileURL(p).href,
  );

  const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : resolve(`${name}.multicam.fcpxml`);
  writeFileSync(outPath, xml);
  console.log(`Wrote ${outPath}: multicam clip with ${group.members.length} angle(s), ${opts.switches.length || 1} switch span(s).`);
  console.log("Import into Final Cut Pro to get a live multicam clip (re-cut angles in the angle viewer).");
}

main();

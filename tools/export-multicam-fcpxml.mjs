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
 *     --start <sec>           trim leading dead air: group time that becomes
 *                             timeline 0 (default 0). Use it when the master audio
 *                             runs before the first video frame — FCP plays such a
 *                             lead out of sync, so start where the cameras roll.
 *     --no-black-fill         don't generate the black-video filler for the angles'
 *                             leading gaps (see below) — the master audio may then
 *                             import late in FCP.
 *     --out <file.fcpxml>     output path (default: <name>.multicam.fcpxml)
 *
 * When the cameras roll after the master audio, each angle has a leading gap. FCP
 * anchors the multicam to the earliest camera and clamps the audio's head-start
 * (playing it late), so this tool generates a black-video clip (`<name>.black.mp4`)
 * that fills those gaps with real frames from time 0 — keeping the audio locked.
 *
 * NOTE: FCPXML multicam is intricate; validate the output by importing it into
 * Final Cut Pro (see docs/manual-test-plan.md). The XML generation in
 * ./fcpxml.mjs is unit-tested; this is the I/O.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMulticamFcpxml } from "./fcpxml.mjs";

// fps as a "num/den" string for ffmpeg (keeps NTSC rates exact).
function fpsArg(fps) {
  const r = Math.round(fps);
  if (Math.abs(fps - r) < 0.001) return String(r);
  if (Math.abs(fps - (r * 1000) / 1001) < 0.01) return `${r * 1000}/1001`;
  return String(fps);
}

function parseArgs(argv) {
  const opts = { file: undefined, group: undefined, name: undefined, total: undefined, start: undefined, width: undefined, height: undefined, out: undefined, switches: [], blackFill: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group") opts.group = argv[++i];
    else if (a === "--name") opts.name = argv[++i];
    else if (a === "--total") opts.total = Number(argv[++i]);
    else if (a === "--start") opts.start = Number(argv[++i]);
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--no-black-fill") opts.blackFill = false;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--switch") {
      const [sec, id] = String(argv[++i]).split("=");
      opts.switches.push({ atSeconds: Number(sec), memberId: id });
    } else if (a === "-h" || a === "--help") {
      console.log("Usage: export-multicam-fcpxml <multicam.json> --width <w> --height <h> [--group <id>] [--switch <sec>=<id>]… [--name <name>] [--total <sec>] [--start <sec>] [--no-black-fill] [--out <file.fcpxml>]");
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
  const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : resolve(`${name}.multicam.fcpxml`);

  // Each camera angle has a leading gap before that camera rolled. FCP anchors the
  // multicam to the earliest camera and clamps the master audio's head-start
  // (playing it late), so fill those gaps with real black-video frames from time 0.
  // Generate one black clip covering the largest gap; the builder trims it per angle.
  const offsetOf = (m) => m.offsetSeconds ?? 0;
  const minOffset = Math.min(...group.members.map(offsetOf));
  const shift = minOffset < 0 ? -minOffset : 0;
  const leads = group.members.filter((m) => m.kind !== "audio").map((m) => offsetOf(m) + shift);
  const maxLead = leads.length ? Math.max(...leads) : 0;
  let blackFiller;
  if (opts.blackFill && maxLead > 0.001) {
    const blackPath = join(dirname(outPath), `${name}.black.mp4`);
    const durationSeconds = Math.ceil((maxLead + 0.5) * 100) / 100; // pad past the largest gap
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi",
      "-i", `color=c=black:s=${opts.width}x${opts.height}:r=${fpsArg(group.projectFps)}:d=${durationSeconds}`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", blackPath,
    ]);
    blackFiller = { path: blackPath, durationSeconds };
    console.log(`Wrote ${blackPath}: ${durationSeconds}s black filler for the angles' leading gaps.`);
  }

  const xml = buildMulticamFcpxml(
    group,
    opts.switches,
    { name, width: opts.width, height: opts.height, totalSeconds: opts.total, startSeconds: opts.start, blackFiller },
    (p) => pathToFileURL(p).href,
  );

  writeFileSync(outPath, xml);
  console.log(`Wrote ${outPath}: multicam clip with ${group.members.length} angle(s), ${opts.switches.length || 1} switch span(s).`);
  console.log("Import into Final Cut Pro to get a live multicam clip (re-cut angles in the angle viewer).");
}

main();

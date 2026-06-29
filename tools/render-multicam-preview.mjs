#!/usr/bin/env node
/**
 * render-multicam-preview — render a synced multi-cam angle cut to a flat MP4 so
 * you can WATCH the edit (and compare it against the Final Cut Pro multicam
 * import from export-multicam-fcpxml). Same group + same `--switch` points →
 * the same cut: each angle span is pulled from its source at the synced offset
 * and concatenated, with the master audio laid continuously underneath.
 *
 * Usage:
 *   render-multicam-preview <multicam.json> [options]
 *     --group <id>            which group in the file (default: the first)
 *     --switch <sec>=<id>     an angle switch point (repeatable); omit for one
 *                             span on the first video angle
 *     --total <sec>           timeline length (default: master audio duration)
 *     --width <w>             output width (default: 1280)
 *     --height <h>            output height (default: 720)
 *     --crf <n>               x264 quality (default: 23)
 *     --out <file.mp4>        output path (default: <group>.preview.mp4)
 *
 * The angle-cut math (source in/out per span, drift retime) is the unit-tested
 * `resolveAngleCuts` in ./multicam.mjs; this module is the ffmpeg I/O (out of
 * automated-coverage scope, like export-project — see docs/manual-test-plan.md).
 * Where a chosen angle has no footage yet (the timeline starts before that
 * camera rolled — a negative source-in), the gap is filled with black, exactly
 * as FCP shows a gap before an angle's media begins.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveAngleCuts } from "./multicam.mjs";

function parseArgs(argv) {
  const opts = { file: undefined, group: undefined, total: undefined, width: 1280, height: 720, crf: 23, out: undefined, switches: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group") opts.group = argv[++i];
    else if (a === "--total") opts.total = Number(argv[++i]);
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--crf") opts.crf = Number(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--switch") {
      const [sec, id] = String(argv[++i]).split("=");
      opts.switches.push({ atSeconds: Number(sec), memberId: id });
    } else if (a === "-h" || a === "--help") {
      console.log("Usage: render-multicam-preview <multicam.json> [--group <id>] [--switch <sec>=<id>]… [--total <sec>] [--width <w>] [--height <h>] [--crf <n>] [--out <file.mp4>]");
      process.exit(0);
    } else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else opts.file = a;
  }
  if (!opts.file) { console.error("Error: a multicam.json path is required."); process.exit(2); }
  return opts;
}

// fps as a "num/den" string for ffmpeg (keeps NTSC rates exact).
function fpsArg(fps) {
  const r = Math.round(fps);
  if (Math.abs(fps - r) < 0.001) return String(r);
  if (Math.abs(fps - (r * 1000) / 1001) < 0.01) return `${r * 1000}/1001`;
  return String(fps);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = JSON.parse(readFileSync(opts.file, "utf8"));
  const groups = doc.groups || [];
  const group = opts.group ? groups.find((g) => g.id === opts.group) : groups[0];
  if (!group) { console.error(opts.group ? `Error: group not found: ${opts.group}` : "Error: no groups in the file."); process.exit(1); }

  const byId = new Map(group.members.map((m) => [m.id, m]));
  const master = byId.get(group.masterAudioId);
  if (!master) { console.error(`Error: master audio member not found: ${group.masterAudioId}`); process.exit(1); }
  const total = opts.total ?? master.durationSeconds;
  if (!(total > 0)) { console.error("Error: a positive --total (or master duration) is required."); process.exit(1); }

  // Default to a single span on the first video angle, mirroring the FCPXML export.
  const firstVideo = group.members.find((m) => m.kind !== "audio") || group.members[0];
  const switches = opts.switches.length ? opts.switches : [{ atSeconds: 0, memberId: firstVideo.id }];
  const segments = resolveAngleCuts(switches, group.members, { totalSeconds: total });

  const { width: W, height: H, crf } = opts;
  const fps = fpsArg(group.projectFps);
  const vf = (extra = "") => `${extra}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},setsar=1,format=yuv420p`;
  const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf), "-an"];

  const tmpDir = mkdtempSync(join(tmpdir(), "mc-preview-"));
  try {
    const parts = [];
    let k = 0;
    for (const s of segments) {
      const m = byId.get(s.memberId);
      const dur = s.timelineOutSeconds - s.timelineInSeconds;
      // A negative source-in means this angle has no footage at the cut point yet
      // (the timeline starts before the camera rolled): fill the lead with black.
      const blackLead = Math.max(0, -s.sourceInSeconds);
      if (blackLead > 1e-3) {
        const bp = join(tmpDir, `seg-${String(k++).padStart(3, "0")}.mp4`);
        console.log(`  ${s.memberId}: ${blackLead.toFixed(2)}s black lead`);
        execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${fps}:d=${blackLead.toFixed(3)}`, "-vf", "setsar=1,format=yuv420p", ...enc, bp]);
        parts.push(bp);
      }
      const srcIn = Math.max(0, s.sourceInSeconds);
      const camDur = dur - blackLead;
      const sp = join(tmpDir, `seg-${String(k++).padStart(3, "0")}.mp4`);
      console.log(`  ${s.memberId}: src ${srcIn.toFixed(2)}s +${camDur.toFixed(2)}s → timeline ${s.timelineInSeconds.toFixed(2)}-${s.timelineOutSeconds.toFixed(2)}s`);
      execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", srcIn.toFixed(3), "-i", m.path, "-t", camDur.toFixed(3), "-vf", vf(), ...enc, sp]);
      parts.push(sp);
    }

    // Concat the (uniformly encoded) parts, then lay the master audio underneath.
    const listPath = join(tmpDir, "list.txt");
    writeFileSync(listPath, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const videoOnly = join(tmpDir, "video.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", videoOnly]);

    const masterOffset = master.offsetSeconds ?? 0; // master local clock at timeline 0
    const audioStart = Math.max(0, -masterOffset);
    const outPath = opts.out ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out)) : resolve(`${group.id}.preview.mp4`);
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-i", videoOnly,
      "-ss", audioStart.toFixed(3), "-i", master.path,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
      "-t", total.toFixed(3), "-movflags", "+faststart", outPath,
    ]);
    if (!existsSync(outPath)) { console.error("Error: ffmpeg did not produce the output."); process.exit(1); }
    console.log(`\nWrote ${outPath}: ${segments.length} angle span(s), ${total.toFixed(2)}s, ${W}x${H} @ ${fps} fps.`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();

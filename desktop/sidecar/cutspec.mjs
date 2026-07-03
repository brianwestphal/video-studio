// Single-source cut-spec proposer (VS-99) — the pure core of the single-video Design lane.
// Turns the scene analysis (sources.json) + an intent into a cut spec: an ordered list of
// clip ranges the export-project tool renders into a finished video / FCPXML. This is
// video-studio's deterministic baseline auto-cut; tailoring it precisely to a prompt is the
// AI Auto lane (VS-96). Pure + side-effect-free; the host reads/writes the JSON.
//
// Cut spec shape (docs/editor-handoff.md):
//   { project: { fps, width, height, name }, clips: [ { source, in, out, audio } ] }

// Rough target duration (seconds) per named cut kind. `full` keeps everything.
export const CUT_TARGETS = Object.freeze({
  teaser: 15,
  sizzle: 20,
  soundbites: 40,
  highlights: 45,
  summary: 60,
  trailer: 75,
});

// Propose a cut spec from an analyzed source pool. `kind` picks a target length + strategy;
// `targetSeconds` overrides it; `maxClipSeconds` caps each montage clip so one long scene
// can't swallow the whole cut. Throws when there are no analyzed scenes to cut from. Pure.
export function proposeCutSpec(sources, { kind = "highlights", targetSeconds, maxClipSeconds = 4 } = {}) {
  const srcs = sources && Array.isArray(sources.sources) ? sources.sources : [];
  const scenes = sources && Array.isArray(sources.scenes) ? sources.scenes : [];
  if (srcs.length === 0 || scenes.length === 0) {
    throw new Error("no analyzed scenes to cut from — import/analyze the footage first");
  }
  const primary = srcs[0];
  const pathFor = (sourceId) => {
    const s = srcs.find((x) => x.id === sourceId);
    return s ? s.path : primary.path;
  };
  const project = { fps: primary.fps, width: primary.width, height: primary.height, name: kind };
  const clip = (sc, inSec, outSec) => ({ source: pathFor(sc.sourceId), in: inSec, out: outSec, audio: "keep" });

  // `full`: keep every scene whole, in order — a lightly-tightened full edit.
  if (kind === "full") {
    return { project, clips: scenes.map((sc) => clip(sc, sc.startSeconds, sc.endSeconds)) };
  }

  // Otherwise a spread montage: walk scenes at an even stride so the cut spans the whole
  // video, cap each to maxClipSeconds, and accumulate until the target length.
  const target = targetSeconds != null ? targetSeconds : (CUT_TARGETS[kind] ?? 45);
  const wanted = Math.max(1, Math.ceil(target / maxClipSeconds));
  const stride = Math.max(1, Math.floor(scenes.length / wanted));
  const clips = [];
  let total = 0;
  for (let i = 0; i < scenes.length && total < target; i += stride) {
    const sc = scenes[i];
    const dur = Math.min(maxClipSeconds, sc.endSeconds - sc.startSeconds, target - total);
    if (dur <= 0) continue;
    clips.push(clip(sc, sc.startSeconds, sc.startSeconds + dur));
    total += dur;
  }
  // Degenerate case (e.g. one very short scene): fall back to the first scene up to target.
  if (clips.length === 0) {
    const sc = scenes[0];
    clips.push(clip(sc, sc.startSeconds, Math.min(sc.endSeconds, sc.startSeconds + target)));
  }
  return { project, clips };
}

// Build the ffmpeg argv that flat-renders a single-source cut spec into a finished video:
// trim each clip range off the one source, concat them, (optionally) scale/pad to a target
// frame (e.g. 1080x1920 for 9:16), and encode H.264/AAC. Pure — the host runs ffmpeg with it.
// Assumes a single source (VS-99 single-source path); throws on an empty cut.
export function flatRenderCommand(cutSpec, outPath, { width, height } = {}) {
  const clips = cutSpec && Array.isArray(cutSpec.clips) ? cutSpec.clips : [];
  if (clips.length === 0) throw new Error("cut spec has no clips");
  const source = clips[0].source;
  const filters = [];
  const concatInputs = [];
  clips.forEach((c, i) => {
    filters.push(`[0:v]trim=start=${c.in}:end=${c.out},setpts=PTS-STARTPTS[v${i}]`);
    filters.push(`[0:a]atrim=start=${c.in}:end=${c.out},asetpts=PTS-STARTPTS[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  filters.push(`${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[cv][ca]`);
  let vLabel = "[cv]";
  if (width && height) {
    filters.push(
      `[cv]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black[vo]`,
    );
    vLabel = "[vo]";
  }
  const args = [
    "-y", "-i", source,
    "-filter_complex", filters.join(";"),
    "-map", vLabel, "-map", "[ca]",
    "-c:v", "libx264", "-crf", "23", "-preset", "veryfast",
    "-c:a", "aac",
    outPath,
  ];
  return { source, args, outPath };
}

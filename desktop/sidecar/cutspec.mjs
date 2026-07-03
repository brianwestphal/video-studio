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

// Mean loudness (rmsDb) over a scene's time window, read off the audio-events envelope
// (rmsDb sampled every hopSeconds). Returns -Infinity when the window has no samples. Pure.
function meanRmsInRange(envelope, a, b) {
  const rms = envelope && Array.isArray(envelope.rmsDb) ? envelope.rmsDb : [];
  const hop = envelope && envelope.hopSeconds > 0 ? envelope.hopSeconds : 0.05;
  const i0 = Math.max(0, Math.floor(a / hop));
  const i1 = Math.min(rms.length, Math.ceil(b / hop));
  if (i1 <= i0) return -Infinity;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += rms[i];
  return sum / (i1 - i0);
}

// Seconds of a scene that overlap audio events of a given kind (e.g. "vocal", "onset"). Pure.
function overlapSeconds(events, kind, sc) {
  let s = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (e.kind !== kind) continue;
    const lo = Math.max(sc.startSeconds, e.startSeconds);
    const hi = Math.min(sc.endSeconds, e.endSeconds);
    if (hi > lo) s += hi - lo;
  }
  return s;
}

// Score a scene for a cut kind: soundbites favor vocal coverage; everything else favors
// loud, punchy moments (energy + onset density). Pure.
function sceneScore(sc, kind, audioEvents) {
  if (kind === "soundbites") return overlapSeconds(audioEvents.events, "vocal", sc);
  return meanRmsInRange(audioEvents.envelope, sc.startSeconds, sc.endSeconds) + overlapSeconds(audioEvents.events, "onset", sc) * 2;
}

// Rank scenes by audio score, take the best until the target length (capped per clip), then
// restore chronological order. Returns [{ sc, in, out }]. Pure.
function selectByAudio(scenes, target, maxClip, kind, audioEvents) {
  const ranked = scenes
    .map((sc, i) => ({ sc, i, score: sceneScore(sc, kind, audioEvents) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const chosen = [];
  let total = 0;
  for (const { sc } of ranked) {
    if (total >= target) break;
    const dur = Math.min(maxClip, sc.endSeconds - sc.startSeconds, target - total);
    if (dur <= 0) continue;
    chosen.push({ sc, in: sc.startSeconds, out: sc.startSeconds + dur });
    total += dur;
  }
  chosen.sort((a, b) => a.in - b.in);
  return chosen;
}

// Walk scenes at an even stride so the cut spans the whole video (no audio guidance).
// Returns [{ sc, in, out }]. Pure.
function selectSpread(scenes, target, maxClip) {
  const wanted = Math.max(1, Math.ceil(target / maxClip));
  const stride = Math.max(1, Math.floor(scenes.length / wanted));
  const chosen = [];
  let total = 0;
  for (let i = 0; i < scenes.length && total < target; i += stride) {
    const sc = scenes[i];
    const dur = Math.min(maxClip, sc.endSeconds - sc.startSeconds, target - total);
    if (dur <= 0) continue;
    chosen.push({ sc, in: sc.startSeconds, out: sc.startSeconds + dur });
    total += dur;
  }
  return chosen;
}

// Propose a cut spec from an analyzed source pool. `kind` picks a target length + strategy;
// `targetSeconds` overrides it; `maxClipSeconds` caps each montage clip so one long scene
// can't swallow the whole cut. When `audioEvents` (audio-events.json) is given, scenes are
// chosen by loudness/onsets (or vocal coverage for soundbites) rather than evenly spread.
// Throws when there are no analyzed scenes to cut from. Pure.
export function proposeCutSpec(sources, { kind = "highlights", targetSeconds, maxClipSeconds = 4 } = {}, audioEvents = null) {
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

  const target = targetSeconds != null ? targetSeconds : (CUT_TARGETS[kind] ?? 45);
  const ranges = audioEvents
    ? selectByAudio(scenes, target, maxClipSeconds, kind, audioEvents)
    : selectSpread(scenes, target, maxClipSeconds);
  const clips = ranges.map((r) => clip(r.sc, r.in, r.out));

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

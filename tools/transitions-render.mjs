// Pure logic for rendering real transitions into the toolkit's own ffmpeg output
// (docs/transitions.md §8, R-TR-R; VS-54) — no Final Cut Pro required. Maps the
// shipped transition palette to ffmpeg `xfade` ids, and turns the exported
// segments (with their baked handles) + the `transitions` list into a render plan:
// per-segment trims + per-join arithmetic (xfade with offset/duration, or a plain
// concat at hard cuts), plus the `-filter_complex` graph. No I/O — the ffmpeg run
// lives in tools/render-transitions.mjs. Held to 100% coverage (vitest.config).

const round3 = (n) => Math.round(n * 1000) / 1000;

// Shipped FCP transition name → ffmpeg `xfade` transition id. Tier A maps directly;
// Tier B/C (no single-filter equivalent) fall back to the nearest Tier-A look (see
// docs/transitions.md §8). Unknown names resolve to `fade` via `xfadeId`.
export const TRANSITION_FFMPEG = {
  // Tier A — direct
  "Cross Dissolve": "dissolve",
  "Fade To Color": "fadeblack",
  Slide: "coverleft",
  Push: "slideleft",
  Wipe: "wipeleft",
  Diagonal: "diagtl",
  Clock: "radial",
  Circle: "circleopen",
  Center: "circlecrop",
  // Tier B/C — nearest-look fallback
  Chevron: "wipeleft",
  Static: "pixelize",
  "Circle Inset": "circleopen",
  "Rectangle Inset": "rectcrop",
  "Shapes Inset": "circleopen",
  "Side-by-Side Split": "slideleft",
  "Top & Bottom Split": "slideup",
};

// Resolve a transition name to an ffmpeg `xfade` id (default `fade`).
export function xfadeId(name) {
  return TRANSITION_FFMPEG[name] ?? "fade";
}

const head = (s) => s.handleStartSeconds ?? 0;
const tail = (s) => s.handleEndSeconds ?? 0;
const fileDur = (s) => s.fileDurationSeconds ?? s.durationSeconds;

// Build a render plan from manifest segments + the normalized `transitions` list
// (each { afterSegment (1-based seg before the cut), name, durationSeconds }).
// `audioTrack` truthy means a continuous master-audio track is muxed separately, so
// segment audio is not crossfaded. Returns:
//   { inputs:  [{ file, trimStart, trimEnd, durationSeconds }],   // per segment
//     joins:   [{ kind: "xfade"|"concat", id?, durationSeconds?, offsetSeconds? }],
//     audio:   "continuous" | "crossfade",
//     totalSeconds }
// Each transition's duration is clamped to ≤ 2×(available handle on each side); a
// cut with no usable handle material degrades to a hard concat.
export function buildTransitionRenderPlan(segments, transitions = [], { audioTrack = false } = {}) {
  if (!segments || segments.length === 0) throw new Error("transitions-render: at least one segment is required");
  const byAfter = new Map();
  for (const tr of transitions) byAfter.set(tr.afterSegment, tr);

  const n = segments.length;
  // Effective (clamped) transition duration at each cut j (between seg j and j+1).
  const effD = new Array(n - 1).fill(0);
  const cutTr = new Array(n - 1).fill(null);
  for (let j = 0; j < n - 1; j++) {
    const tr = byAfter.get(segments[j].index);
    if (!tr) continue;
    const room = 2 * Math.min(tail(segments[j]), head(segments[j + 1]));
    const d = Math.min(tr.durationSeconds, room);
    if (d > 0) {
      effD[j] = d;
      cutTr[j] = tr;
    }
  }

  // Per-segment trim: extend into the head/tail handle by half the adjacent
  // transition so the dissolve is centered on the cut and no visible frame is lost.
  const inputs = segments.map((s, j) => {
    const dLeft = j > 0 ? effD[j - 1] : 0;
    const dRight = j < n - 1 ? effD[j] : 0;
    const trimStart = Math.max(0, head(s) - dLeft / 2);
    const trimEnd = Math.min(fileDur(s), head(s) + s.durationSeconds + dRight / 2);
    return { file: s.file, trimStart: round3(trimStart), trimEnd: round3(trimEnd), durationSeconds: round3(trimEnd - trimStart) };
  });

  // Chain the pieces, tracking the running output length to place each xfade offset.
  const joins = [];
  let running = inputs[0].durationSeconds;
  for (let j = 1; j < n; j++) {
    const d = effD[j - 1];
    if (d > 0) {
      joins.push({ kind: "xfade", id: xfadeId(cutTr[j - 1].name), durationSeconds: round3(d), offsetSeconds: round3(running - d) });
      running = round3(running + inputs[j].durationSeconds - d);
    } else {
      joins.push({ kind: "concat" });
      running = round3(running + inputs[j].durationSeconds);
    }
  }

  return { inputs, joins, audio: audioTrack ? "continuous" : "crossfade", totalSeconds: running };
}

// Assemble the ffmpeg `-filter_complex` graph for a plan. Video is chained with
// `xfade` (transitions) / `concat` (hard cuts); when `audio` is "crossfade" the
// segment audio is chained in parallel with `acrossfade` / `concat`. Returns
// { filter, vOut, aOut } where vOut/aOut are the final stream labels (aOut null
// for the continuous-audio case, where the caller muxes the master track instead).
export function transitionFilterComplex(plan) {
  const parts = [];
  // Video: label each input's trimmed, timebase-reset video stream.
  plan.inputs.forEach((_, i) => parts.push(`[${i}:v]setpts=PTS-STARTPTS[v${i}]`));
  let vAcc = "v0";
  plan.joins.forEach((join, k) => {
    const next = `v${k + 1}`;
    const out = `vx${k}`;
    if (join.kind === "xfade") {
      parts.push(`[${vAcc}][${next}]xfade=transition=${join.id}:duration=${join.durationSeconds}:offset=${join.offsetSeconds}[${out}]`);
    } else {
      parts.push(`[${vAcc}][${next}]concat=n=2:v=1:a=0[${out}]`);
    }
    vAcc = out;
  });

  let aOut = null;
  if (plan.audio === "crossfade") {
    plan.inputs.forEach((_, i) => parts.push(`[${i}:a]asetpts=PTS-STARTPTS[a${i}]`));
    let aAcc = "a0";
    plan.joins.forEach((join, k) => {
      const next = `a${k + 1}`;
      const out = `ax${k}`;
      if (join.kind === "xfade") {
        parts.push(`[${aAcc}][${next}]acrossfade=d=${join.durationSeconds}[${out}]`);
      } else {
        parts.push(`[${aAcc}][${next}]concat=n=2:v=0:a=1[${out}]`);
      }
      aAcc = out;
    });
    aOut = aAcc;
  }

  return { filter: parts.join(";"), vOut: vAcc, aOut };
}

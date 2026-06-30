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

// --- Native Tier-B/C recipes (VS-55) ----------------------------------------
// The full-chain renderer (buildTransitionRenderPlan) can only chain single
// `xfade` filters, so Tier B/C degrade to the nearest Tier-A id above. The
// windowed renderer (buildWindowedRenderPlan) renders each transition as its own
// short clip, so it can run a richer per-clip filtergraph and reproduce Tier B/C
// natively. These are the per-clip recipes (see docs/render-transitions.md).

// Tier B — `xfade=custom` pixel expressions. Variables: P (progress 1→0), X/Y,
// W/H, A/B (the two inputs' pixel for the current plane). The expr returns the
// output pixel value.
//   Chevron: a sideways-V wipe — the reveal edge leads at the vertical centre and
//   trails at the top/bottom, so the boundary is a chevron pointing in the wipe
//   direction. At P=1 it's all A; at P=0 the edge has crossed the full frame → all B.
export const CHEVRON_EXPR = "if(lt(X,(1-P)*(W+H/2)-abs(Y-H/2)),B,A)";
//   Static: a noise-modulated dissolve — each pixel flips A→B once the dissolve
//   progress (1-P) passes that pixel's stable pseudo-random threshold, giving a
//   TV-static break-up rather than a uniform fade.
export const STATIC_EXPR = "if(lt(1-P,abs(mod(sin(X*12.9898+Y*78.233)*43758.5453,1))),A,B)";

// Shipped FCP transition name → native windowed recipe. `tier` records the effort
// class; `xfade` is the Tier-A id; `expr` is the Tier-B custom expression; `recipe`
// names the Tier-C compositing filtergraph (built in windowedClipFilter).
export const TRANSITION_RECIPES = {
  // Tier A — a single direct `xfade`
  "Cross Dissolve": { tier: "A", xfade: "dissolve" },
  "Fade To Color": { tier: "A", xfade: "fadeblack" },
  Slide: { tier: "A", xfade: "coverleft" },
  Push: { tier: "A", xfade: "slideleft" },
  Wipe: { tier: "A", xfade: "wipeleft" },
  Diagonal: { tier: "A", xfade: "diagtl" },
  Clock: { tier: "A", xfade: "radial" },
  Circle: { tier: "A", xfade: "circleopen" },
  Center: { tier: "A", xfade: "circlecrop" },
  // Tier B — `xfade=custom` expression
  Chevron: { tier: "B", expr: CHEVRON_EXPR },
  Static: { tier: "B", expr: STATIC_EXPR },
  // Tier C — overlay + animated alpha mask / crop-and-slide
  "Circle Inset": { tier: "C", recipe: "inset-circle" },
  "Rectangle Inset": { tier: "C", recipe: "inset-rect" },
  "Shapes Inset": { tier: "C", recipe: "inset-circle" },
  "Side-by-Side Split": { tier: "C", recipe: "split-h" },
  "Top & Bottom Split": { tier: "C", recipe: "split-v" },
};

// Resolve a transition name to its native recipe (default: Tier-A `fade`).
export function transitionRecipe(name) {
  return TRANSITION_RECIPES[name] ?? { tier: "A", xfade: "fade" };
}

const head = (s) => s.handleStartSeconds ?? 0;
const tail = (s) => s.handleEndSeconds ?? 0;
const fileDur = (s) => s.fileDurationSeconds ?? s.durationSeconds;

// Per-cut effective (handle-clamped) transition durations + the chosen transition.
// Shared by the full-chain and windowed planners. `effD[j]` is the centered
// transition duration at the cut between segment j and j+1 (0 = hard cut, i.e. no
// transition listed or no usable handle material); `cutTr[j]` is that transition.
// Each duration is clamped to ≤ 2×(available handle on each side).
function cutEffects(segments, transitions) {
  const byAfter = new Map();
  for (const tr of transitions) byAfter.set(tr.afterSegment, tr);
  const n = segments.length;
  const effD = new Array(Math.max(0, n - 1)).fill(0);
  const cutTr = new Array(Math.max(0, n - 1)).fill(null);
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
  return { effD, cutTr };
}

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
  const n = segments.length;
  const { effD, cutTr } = cutEffects(segments, transitions);

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

// --- Windowed render plan (VS-55) -------------------------------------------
// The full-chain plan above re-encodes the whole timeline. Since the exported
// segments are all-intra ProRes, the windowed plan re-encodes only the short
// overlap at each transition and stream-copy-concats the rest, so the render cost
// is ≈ Σ(transition duration) regardless of clip length. It splits each segment
// into a `body` span (stream-copied, the part not consumed by an adjacent
// transition) and, at each transitioned cut, a `clip` (the centered overlap, the
// only part re-encoded). See docs/render-transitions.md (R-RT1–R-RT3).
//
// Returns:
//   { bodies: [{ index, file, trimStart, durationSeconds }],            // n, stream-copy
//     clips:  [ null                                                    // n-1, null = hard cut
//               | { afterIndex, name, tier, recipe, durationSeconds,
//                   left:  { file, trimStart, durationSeconds },
//                   right: { file, trimStart, durationSeconds } } ],
//     audio: "continuous" | "crossfade",
//     totalSeconds }
// Concat order is: body[0], clip[0]?, body[1], clip[1]?, … (clip[j] omitted/null
// at a hard cut, where body[j] and body[j+1] simply abut). A degenerate body fully
// consumed by its two transitions clamps to duration 0 (the I/O skips it).
export function buildWindowedRenderPlan(segments, transitions = [], { audioTrack = false } = {}) {
  if (!segments || segments.length === 0) throw new Error("transitions-render: at least one segment is required");
  const n = segments.length;
  const { effD, cutTr } = cutEffects(segments, transitions);

  const bodies = segments.map((s, j) => {
    const dLeft = j > 0 ? effD[j - 1] : 0;
    const dRight = j < n - 1 ? effD[j] : 0;
    const trimStart = head(s) + dLeft / 2;
    const durationSeconds = Math.max(0, s.durationSeconds - dLeft / 2 - dRight / 2);
    return { index: s.index, file: s.file, trimStart: round3(trimStart), durationSeconds: round3(durationSeconds) };
  });

  const clips = [];
  for (let j = 0; j < n - 1; j++) {
    const d = effD[j];
    if (d <= 0) {
      clips.push(null);
      continue;
    }
    const a = segments[j];
    const b = segments[j + 1];
    const recipe = transitionRecipe(cutTr[j].name);
    clips.push({
      afterIndex: a.index,
      name: cutTr[j].name,
      tier: recipe.tier,
      recipe,
      durationSeconds: round3(d),
      left: { file: a.file, trimStart: round3(head(a) + a.durationSeconds - d / 2), durationSeconds: round3(d) },
      right: { file: b.file, trimStart: round3(head(b) - d / 2), durationSeconds: round3(d) },
    });
  }

  const totalSeconds = round3(
    bodies.reduce((t, body) => t + body.durationSeconds, 0) +
      clips.reduce((t, c) => t + (c ? c.durationSeconds : 0), 0),
  );
  return { bodies, clips, audio: audioTrack ? "continuous" : "crossfade", totalSeconds };
}

// Geq alpha-mask expressions for the Tier-C inset transitions (the incoming clip
// reveals through a shape that grows from the centre over the clip). `T` is the
// frame time, `d` the clip duration; `W`/`H`/`X`/`Y` are geq's frame coordinates.
const insetAlpha = {
  circle: (d) => `if(lte(hypot(X-W/2\\,Y-H/2)\\,(T/${d})*hypot(W/2\\,H/2))\\,255\\,0)`,
  rect: (d) => `255*lt(abs(X-W/2)\\,(T/${d})*W/2)*lt(abs(Y-H/2)\\,(T/${d})*H/2)`,
};

// Build the `-filter_complex` for ONE windowed transition clip. The clip's two
// ffmpeg inputs are the centered overlap windows: [0]=outgoing (A), [1]=incoming
// (B), each exactly `durationSeconds` long. Returns { filter, vOut, aOut } (aOut
// null when `audio` is "continuous" — the master track is muxed separately).
//   Tier A → a direct `xfade` (offset 0, the whole clip is the transition);
//   Tier B → `xfade=custom` with the recipe's pixel expression;
//   Tier C → overlay + an animated alpha mask (inset) or crop-and-slide (split).
export function windowedClipFilter(recipe, { durationSeconds: d, audio = "crossfade" } = {}) {
  const parts = ["[0:v]setpts=PTS-STARTPTS[a]", "[1:v]setpts=PTS-STARTPTS[b]"];
  if (recipe.tier === "A") {
    parts.push(`[a][b]xfade=transition=${recipe.xfade}:duration=${d}:offset=0,format=yuv422p10le[vout]`);
  } else if (recipe.tier === "B") {
    parts.push(`[a][b]xfade=transition=custom:expr='${recipe.expr}':duration=${d}:offset=0,format=yuv422p10le[vout]`);
  } else if (recipe.recipe === "inset-circle" || recipe.recipe === "inset-rect") {
    const alpha = recipe.recipe === "inset-circle" ? insetAlpha.circle(d) : insetAlpha.rect(d);
    parts.push(`[b]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[ov]`);
    parts.push(`[a][ov]overlay=0:0,format=yuv422p10le[vout]`);
  } else {
    // split-h / split-v: the outgoing (A) splits into two halves that slide apart
    // to reveal the incoming (B) underneath.
    const horiz = recipe.recipe === "split-h";
    parts.push("[a]split[a1][a2]");
    if (horiz) {
      parts.push("[a1]crop=iw/2:ih:0:0[al]", "[a2]crop=iw/2:ih:iw/2:0[ar]");
      parts.push(`[b][al]overlay=x='-w*(t/${d})':y=0[t1]`);
      parts.push(`[t1][ar]overlay=x='w+w*(t/${d})':y=0,format=yuv422p10le[vout]`);
    } else {
      parts.push("[a1]crop=iw:ih/2:0:0[at]", "[a2]crop=iw:ih/2:0:ih/2[ab]");
      parts.push(`[b][at]overlay=x=0:y='-h*(t/${d})'[t1]`);
      parts.push(`[t1][ab]overlay=x=0:y='h+h*(t/${d})',format=yuv422p10le[vout]`);
    }
  }

  let aOut = null;
  if (audio === "crossfade") {
    parts.push("[0:a]asetpts=PTS-STARTPTS[a0]", "[1:a]asetpts=PTS-STARTPTS[a1a]");
    parts.push(`[a0][a1a]acrossfade=d=${d}[aout]`);
    aOut = "aout";
  }
  return { filter: parts.join(";"), vOut: "vout", aOut };
}

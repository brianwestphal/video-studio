import { describe, expect, it } from "vitest";
import {
  buildTransitionRenderPlan,
  buildWindowedRenderPlan,
  CHEVRON_EXPR,
  STATIC_EXPR,
  TRANSITION_FFMPEG,
  TRANSITION_RECIPES,
  transitionFilterComplex,
  transitionRecipe,
  windowedClipFilter,
  xfadeId,
  // @ts-expect-error — JS module, no types
} from "../tools/transitions-render.mjs";

// A handled segment: visible `dur`, `h` of handle on each side, fileDur = h+dur+h.
function seg(index: number, dur = 1.0, h = 0.5) {
  return { index, file: `segments/seg-00${index}.mov`, durationSeconds: dur, handleStartSeconds: h, handleEndSeconds: h, fileDurationSeconds: h + dur + h, audio: "keep" };
}

describe("xfadeId / TRANSITION_FFMPEG", () => {
  it("maps the shipped palette to xfade ids", () => {
    expect(xfadeId("Cross Dissolve")).toBe("dissolve");
    expect(xfadeId("Wipe")).toBe("wipeleft");
    expect(xfadeId("Clock")).toBe("radial");
    expect(Object.keys(TRANSITION_FFMPEG)).toContain("Side-by-Side Split");
  });
  it("falls back to `fade` for an unknown transition name", () => {
    expect(xfadeId("Nonexistent Transition")).toBe("fade");
  });
});

describe("buildTransitionRenderPlan", () => {
  it("requires at least one segment", () => {
    expect(() => buildTransitionRenderPlan([], [])).toThrow(/at least one segment/);
    expect(() => buildTransitionRenderPlan(undefined, [])).toThrow(/at least one segment/);
  });

  it("centers each transition on the cut using handles and chains xfade offsets", () => {
    const segs = [seg(1), seg(2), seg(3)];
    const trans = [
      { afterSegment: 1, name: "Cross Dissolve", durationSeconds: 0.4 },
      { afterSegment: 2, name: "Wipe", durationSeconds: 0.4 },
    ];
    const plan = buildTransitionRenderPlan(segs, trans, {});
    expect(plan.inputs).toEqual([
      { file: "segments/seg-001.mov", trimStart: 0.5, trimEnd: 1.7, durationSeconds: 1.2 },
      { file: "segments/seg-002.mov", trimStart: 0.3, trimEnd: 1.7, durationSeconds: 1.4 },
      { file: "segments/seg-003.mov", trimStart: 0.3, trimEnd: 1.5, durationSeconds: 1.2 },
    ]);
    expect(plan.joins).toEqual([
      { kind: "xfade", id: "dissolve", durationSeconds: 0.4, offsetSeconds: 0.8 },
      { kind: "xfade", id: "wipeleft", durationSeconds: 0.4, offsetSeconds: 1.8 },
    ]);
    expect(plan.totalSeconds).toBe(3); // visible time preserved (handles absorb the dissolve)
    expect(plan.audio).toBe("crossfade");
  });

  it("clamps a transition longer than the available handle material", () => {
    const segs = [seg(1, 1.0, 0.1), seg(2, 1.0, 0.1)];
    const plan = buildTransitionRenderPlan(segs, [{ afterSegment: 1, name: "Cross Dissolve", durationSeconds: 1.0 }], {});
    expect(plan.joins[0]).toEqual({ kind: "xfade", id: "dissolve", durationSeconds: 0.2, offsetSeconds: 0.9 });
    expect(plan.totalSeconds).toBe(2);
  });

  it("degrades to a hard concat when a side has no handle material", () => {
    const segs = [{ ...seg(1), handleEndSeconds: 0 }, seg(2)];
    const plan = buildTransitionRenderPlan(segs, [{ afterSegment: 1, name: "Cross Dissolve", durationSeconds: 0.4 }], {});
    expect(plan.joins).toEqual([{ kind: "concat" }]);
    expect(plan.totalSeconds).toBe(2);
  });

  it("mixes a hard cut (no transition listed) with a transition", () => {
    const segs = [seg(1), seg(2), seg(3)];
    const plan = buildTransitionRenderPlan(segs, [{ afterSegment: 2, name: "Wipe", durationSeconds: 0.4 }], {});
    expect(plan.joins.map((j: { kind: string }) => j.kind)).toEqual(["concat", "xfade"]);
  });

  it("marks audio continuous when a master audioTrack is present", () => {
    const plan = buildTransitionRenderPlan([seg(1), seg(2)], [{ afterSegment: 1, name: "Slide", durationSeconds: 0.4 }], { audioTrack: true });
    expect(plan.audio).toBe("continuous");
  });

  it("falls back to zero handles / file duration when the fields are absent", () => {
    const segs = [
      { index: 1, file: "segments/seg-001.mov", durationSeconds: 1.0 },
      { index: 2, file: "segments/seg-002.mov", durationSeconds: 1.0 },
    ];
    const plan = buildTransitionRenderPlan(segs, [{ afterSegment: 1, name: "Cross Dissolve", durationSeconds: 0.4 }], {});
    expect(plan.joins).toEqual([{ kind: "concat" }]); // no handle material → hard cut
    expect(plan.inputs[0]).toEqual({ file: "segments/seg-001.mov", trimStart: 0, trimEnd: 1, durationSeconds: 1 });
  });
});

describe("transitionFilterComplex", () => {
  it("chains xfade video + acrossfade audio for the crossfade case", () => {
    const plan = buildTransitionRenderPlan([seg(1), seg(2)], [{ afterSegment: 1, name: "Cross Dissolve", durationSeconds: 0.4 }], {});
    const fc = transitionFilterComplex(plan);
    expect(fc.filter).toContain("[v0][v1]xfade=transition=dissolve:duration=0.4:offset=0.8[vx0]");
    expect(fc.filter).toContain("[a0][a1]acrossfade=d=0.4[ax0]");
    expect(fc).toMatchObject({ vOut: "vx0", aOut: "ax0" });
  });

  it("uses concat filters at hard cuts and omits audio when continuous", () => {
    const plan = buildTransitionRenderPlan([seg(1), seg(2)], [], { audioTrack: true });
    const fc = transitionFilterComplex(plan);
    expect(fc.filter).toContain("concat=n=2:v=1:a=0[vx0]");
    expect(fc.filter).not.toContain("acrossfade");
    expect(fc.filter).not.toContain("concat=n=2:v=0:a=1");
    expect(fc.aOut).toBeNull();
  });

  it("emits an audio concat at a hard cut in the crossfade case", () => {
    const plan = buildTransitionRenderPlan([seg(1), seg(2)], [], {});
    const fc = transitionFilterComplex(plan);
    expect(fc.filter).toContain("concat=n=2:v=0:a=1[ax0]");
    expect(fc.aOut).toBe("ax0");
  });
});

describe("transitionRecipe / TRANSITION_RECIPES (VS-55 native tiers)", () => {
  it("classifies the palette into Tier A/B/C with native recipes", () => {
    expect(transitionRecipe("Cross Dissolve")).toEqual({ tier: "A", xfade: "dissolve" });
    expect(transitionRecipe("Chevron")).toEqual({ tier: "B", expr: CHEVRON_EXPR });
    expect(transitionRecipe("Static")).toEqual({ tier: "B", expr: STATIC_EXPR });
    expect(transitionRecipe("Circle Inset")).toEqual({ tier: "C", recipe: "inset-circle" });
    expect(transitionRecipe("Rectangle Inset")).toEqual({ tier: "C", recipe: "inset-rect" });
    expect(transitionRecipe("Shapes Inset")).toEqual({ tier: "C", recipe: "inset-circle" });
    expect(transitionRecipe("Side-by-Side Split")).toEqual({ tier: "C", recipe: "split-h" });
    expect(transitionRecipe("Top & Bottom Split")).toEqual({ tier: "C", recipe: "split-v" });
  });
  it("covers every shipped transition name", () => {
    for (const name of Object.keys(TRANSITION_FFMPEG)) expect(TRANSITION_RECIPES[name]).toBeDefined();
  });
  it("falls back to a Tier-A `fade` for an unknown name", () => {
    expect(transitionRecipe("Nonexistent")).toEqual({ tier: "A", xfade: "fade" });
  });
});

describe("buildWindowedRenderPlan", () => {
  it("requires at least one segment", () => {
    expect(() => buildWindowedRenderPlan([], [])).toThrow(/at least one segment/);
    expect(() => buildWindowedRenderPlan(undefined, [])).toThrow(/at least one segment/);
  });

  it("splits segments into stream-copy bodies + centered transition clips", () => {
    const segs = [seg(1), seg(2), seg(3)];
    const trans = [
      { afterSegment: 1, name: "Cross Dissolve", durationSeconds: 0.4 },
      { afterSegment: 2, name: "Wipe", durationSeconds: 0.4 },
    ];
    const plan = buildWindowedRenderPlan(segs, trans, {});
    expect(plan.bodies).toEqual([
      { index: 1, file: "segments/seg-001.mov", trimStart: 0.5, durationSeconds: 0.8 },
      { index: 2, file: "segments/seg-002.mov", trimStart: 0.7, durationSeconds: 0.6 },
      { index: 3, file: "segments/seg-003.mov", trimStart: 0.7, durationSeconds: 0.8 },
    ]);
    expect(plan.clips).toEqual([
      {
        afterIndex: 1, name: "Cross Dissolve", tier: "A", recipe: { tier: "A", xfade: "dissolve" }, durationSeconds: 0.4,
        left: { file: "segments/seg-001.mov", trimStart: 1.3, durationSeconds: 0.4 },
        right: { file: "segments/seg-002.mov", trimStart: 0.3, durationSeconds: 0.4 },
      },
      {
        afterIndex: 2, name: "Wipe", tier: "A", recipe: { tier: "A", xfade: "wipeleft" }, durationSeconds: 0.4,
        left: { file: "segments/seg-002.mov", trimStart: 1.3, durationSeconds: 0.4 },
        right: { file: "segments/seg-003.mov", trimStart: 0.3, durationSeconds: 0.4 },
      },
    ]);
    expect(plan.totalSeconds).toBe(3); // bodies (2.2) + clips (0.8) = visible timeline
    expect(plan.audio).toBe("crossfade");
  });

  it("emits a null clip (bodies abut) at a hard cut and at a no-handle cut", () => {
    const segs = [seg(1), { ...seg(2), handleEndSeconds: 0 }, seg(3)];
    const plan = buildWindowedRenderPlan(segs, [
      { afterSegment: 1, name: "Wipe", durationSeconds: 0.4 }, // seg1.tail ok, seg2.head ok → real clip
      { afterSegment: 2, name: "Wipe", durationSeconds: 0.4 }, // seg2.tail=0 → no handle → null
    ], {});
    expect(plan.clips[0]).not.toBeNull();
    expect(plan.clips[1]).toBeNull();
    // The body between two cuts where the right cut is hard keeps its full tail.
    expect(plan.bodies[2]).toEqual({ index: 3, file: "segments/seg-003.mov", trimStart: 0.5, durationSeconds: 1 });
  });

  it("clamps a transition to the available handle material", () => {
    const segs = [seg(1, 1.0, 0.1), seg(2, 1.0, 0.1)];
    const plan = buildWindowedRenderPlan(segs, [{ afterSegment: 1, name: "Cross Dissolve", durationSeconds: 1.0 }], {});
    expect(plan.clips[0].durationSeconds).toBe(0.2);
    expect(plan.clips[0].left.trimStart).toBe(1); // head 0.1 + dur 1.0 - 0.2/2
    expect(plan.totalSeconds).toBe(2);
  });

  it("clamps a body fully consumed by transitions to zero duration", () => {
    // A short visible segment (0.3 s) flanked by two 0.4 s transitions removes
    // 0.2 + 0.2 = 0.4 s > 0.3 s → the body would go negative; it clamps to 0.
    const segs = [seg(1), seg(2, 0.3), seg(3)];
    const plan = buildWindowedRenderPlan(segs, [
      { afterSegment: 1, name: "Wipe", durationSeconds: 0.4 },
      { afterSegment: 2, name: "Wipe", durationSeconds: 0.4 },
    ], {});
    expect(plan.bodies[1].durationSeconds).toBe(0);
  });

  it("marks audio continuous when a master audioTrack is present", () => {
    const plan = buildWindowedRenderPlan([seg(1), seg(2)], [{ afterSegment: 1, name: "Slide", durationSeconds: 0.4 }], { audioTrack: true });
    expect(plan.audio).toBe("continuous");
  });

  it("falls back to zero handles / file duration when the fields are absent", () => {
    const segs = [
      { index: 1, file: "segments/seg-001.mov", durationSeconds: 1.0 },
      { index: 2, file: "segments/seg-002.mov", durationSeconds: 1.0 },
    ];
    const plan = buildWindowedRenderPlan(segs, [{ afterSegment: 1, name: "Cross Dissolve", durationSeconds: 0.4 }], {});
    expect(plan.clips).toEqual([null]); // no handle material → bodies abut
    expect(plan.bodies).toEqual([
      { index: 1, file: "segments/seg-001.mov", trimStart: 0, durationSeconds: 1 },
      { index: 2, file: "segments/seg-002.mov", trimStart: 0, durationSeconds: 1 },
    ]);
  });
});

describe("windowedClipFilter", () => {
  const D = 0.4;
  it("Tier A → a direct xfade at offset 0 with acrossfade audio", () => {
    const fc = windowedClipFilter({ tier: "A", xfade: "dissolve" }, { durationSeconds: D, audio: "crossfade" });
    expect(fc.filter).toContain("[a][b]xfade=transition=dissolve:duration=0.4:offset=0,format=yuv422p10le[vout]");
    expect(fc.filter).toContain("[a0][a1a]acrossfade=d=0.4[aout]");
    expect(fc).toMatchObject({ vOut: "vout", aOut: "aout" });
  });
  it("Tier B → xfade=custom with the recipe expression", () => {
    const fc = windowedClipFilter(transitionRecipe("Chevron"), { durationSeconds: D });
    expect(fc.filter).toContain(`xfade=transition=custom:expr='${CHEVRON_EXPR}':duration=0.4:offset=0`);
  });
  it("Tier C inset-circle → a growing circular alpha mask overlaid on the outgoing", () => {
    const fc = windowedClipFilter({ tier: "C", recipe: "inset-circle" }, { durationSeconds: D });
    expect(fc.filter).toContain("[b]format=rgba,geq=");
    expect(fc.filter).toContain("hypot(X-W/2");
    expect(fc.filter).toContain("[a][ov]overlay=0:0,format=yuv422p10le[vout]");
  });
  it("Tier C inset-rect → a growing rectangular alpha mask", () => {
    const fc = windowedClipFilter({ tier: "C", recipe: "inset-rect" }, { durationSeconds: D });
    expect(fc.filter).toContain("255*lt(abs(X-W/2)");
  });
  it("Tier C split-h → crop halves sliding apart horizontally", () => {
    const fc = windowedClipFilter({ tier: "C", recipe: "split-h" }, { durationSeconds: D });
    expect(fc.filter).toContain("[a]split[a1][a2]");
    expect(fc.filter).toContain("crop=iw/2:ih:0:0[al]");
    expect(fc.filter).toContain("overlay=x='-w*(t/0.4)':y=0");
    expect(fc.filter).toContain("overlay=x='w+w*(t/0.4)':y=0");
  });
  it("Tier C split-v → crop halves sliding apart vertically", () => {
    const fc = windowedClipFilter({ tier: "C", recipe: "split-v" }, { durationSeconds: D });
    expect(fc.filter).toContain("crop=iw:ih/2:0:0[at]");
    expect(fc.filter).toContain("overlay=x=0:y='-h*(t/0.4)'");
    expect(fc.filter).toContain("overlay=x=0:y='h+h*(t/0.4)'");
  });
  it("omits audio when continuous (master track muxed separately)", () => {
    const fc = windowedClipFilter({ tier: "A", xfade: "fade" }, { durationSeconds: D, audio: "continuous" });
    expect(fc.filter).not.toContain("acrossfade");
    expect(fc.aOut).toBeNull();
  });
  it("defaults to a crossfade clip when no options are given", () => {
    const fc = windowedClipFilter({ tier: "A", xfade: "fade" });
    expect(fc.aOut).toBe("aout");
    expect(fc.filter).toContain("duration=undefined"); // duration flows through verbatim
  });
});

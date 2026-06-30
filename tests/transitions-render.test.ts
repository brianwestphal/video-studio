import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module, no types
import { buildTransitionRenderPlan, TRANSITION_FFMPEG, transitionFilterComplex, xfadeId } from "../tools/transitions-render.mjs";

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

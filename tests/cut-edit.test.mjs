import { describe, it, expect } from "vitest";
import { dropClip, reorderClip, trimClip, cutDuration } from "../desktop/sidecar/cut-edit.mjs";

const mkCut = () => ({
  project: { fps: 24, width: 1920, height: 1080, name: "teaser" },
  clips: [
    { source: "/v.mp4", in: 0, out: 3, audio: "keep" },
    { source: "/v.mp4", in: 10, out: 14, audio: "keep" },
    { source: "/v.mp4", in: 20, out: 22, audio: "keep" },
  ],
});

describe("cut-edit — dropClip", () => {
  it("removes the clip at the index, preserving the rest + project, without mutating input", () => {
    const cut = mkCut();
    const out = dropClip(cut, 1);
    expect(out.clips.map((c) => c.in)).toEqual([0, 20]);
    expect(out.project).toEqual(cut.project);
    expect(cut.clips).toHaveLength(3); // input untouched
  });
  it("is a no-op for an out-of-range / non-integer index", () => {
    const cut = mkCut();
    expect(dropClip(cut, -1)).toBe(cut);
    expect(dropClip(cut, 3)).toBe(cut);
    expect(dropClip(cut, 1.5)).toBe(cut);
  });
  it("tolerates a cut with no clips array", () => {
    expect(dropClip({}, 0)).toEqual({});
  });
});

describe("cut-edit — reorderClip", () => {
  it("moves a clip forward and backward (FIFO splice)", () => {
    const cut = mkCut();
    expect(reorderClip(cut, 0, 2).clips.map((c) => c.in)).toEqual([10, 20, 0]);
    expect(reorderClip(cut, 2, 0).clips.map((c) => c.in)).toEqual([20, 0, 10]);
  });
  it("no-ops on out-of-range, non-integer, or from===to", () => {
    const cut = mkCut();
    expect(reorderClip(cut, 0, 0)).toBe(cut);
    expect(reorderClip(cut, -1, 1)).toBe(cut);
    expect(reorderClip(cut, 0, 3)).toBe(cut);
    expect(reorderClip(cut, 1.2, 0)).toBe(cut);
  });
});

describe("cut-edit — trimClip", () => {
  it("sets in/out (either omitted keeps current), not mutating input", () => {
    const cut = mkCut();
    const out = trimClip(cut, 0, { out: 2 });
    expect(out.clips[0]).toMatchObject({ in: 0, out: 2, audio: "keep" });
    expect(cut.clips[0].out).toBe(3);
    expect(trimClip(cut, 1, { in: 11 }).clips[1]).toMatchObject({ in: 11, out: 14 });
  });
  it("clamps a negative in to 0", () => {
    expect(trimClip(mkCut(), 0, { in: -5 }).clips[0].in).toBe(0);
  });
  it("rejects a non-positive range (out <= in) as a no-op", () => {
    const cut = mkCut();
    expect(trimClip(cut, 0, { in: 3, out: 3 })).toBe(cut);
    expect(trimClip(cut, 0, { in: 5, out: 2 })).toBe(cut);
  });
  it("no-ops for an out-of-range index", () => {
    const cut = mkCut();
    expect(trimClip(cut, 9, { out: 1 })).toBe(cut);
  });
});

describe("cut-edit — cutDuration", () => {
  it("sums each clip's (out - in)", () => {
    expect(cutDuration(mkCut())).toBe(3 + 4 + 2);
  });
  it("floors a negative/degenerate clip at 0, treats a missing in/out as 0, tolerates an empty cut", () => {
    expect(cutDuration({ clips: [{ in: 5, out: 2 }, { in: 0, out: 4 }] })).toBe(4);
    expect(cutDuration({ clips: [{ in: 1 }, { out: 3 }] })).toBe(3); // missing out → 0-len; missing in → 0..3
    expect(cutDuration({})).toBe(0);
  });
});

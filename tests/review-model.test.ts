import { describe, expect, it } from "vitest";
import {
  applyReview,
  candidateAngles,
  reviewSegments,
  // @ts-expect-error — JS module, no types
} from "../tools/review-model.mjs";

// A switch list + parallel rationale carrying the R-AC9 review signal.
const switches = [
  { atSeconds: 0, memberId: "a" },
  { atSeconds: 4, memberId: "b" },
  { atSeconds: 9, memberId: "a" },
];
const rationale = [
  { runnerUp: "b", confidence: 0.1, why: "near tie", flagged: true },
  { runnerUp: "a", confidence: 0.8, why: "clear", flagged: false },
  { runnerUp: "b", confidence: 0.4, why: "low vision conf", flagged: true },
];

describe("reviewSegments", () => {
  it("returns [] when switches is not an array", () => {
    expect(reviewSegments({ switches: undefined, timelineEnd: 10 })).toEqual([]);
  });

  it("returns only flagged switches by default, with clamped ±context windows", () => {
    const segs = reviewSegments({ switches, rationale, timelineEnd: 12, contextSeconds: 2 });
    expect(segs.map((s: { index: number }) => s.index)).toEqual([0, 2]); // switch 1 is not flagged
    // segment 0: at 0 → previewStart clamps to 0; end = next switch (4)
    expect(segs[0]).toMatchObject({ atSeconds: 0, endSeconds: 4, chosen: "a", runnerUp: "b", confidence: 0.1, previewStart: 0, previewEnd: 6 });
    // segment 2: last → end = timelineEnd (12); previewEnd clamps to 12
    expect(segs[1]).toMatchObject({ index: 2, atSeconds: 9, endSeconds: 12, chosen: "a", previewStart: 7, previewEnd: 12 });
  });

  it("includes every switch (and null signal fields) when includeAll and rationale is missing", () => {
    const segs = reviewSegments({ switches, rationale: [], timelineEnd: 12, includeAll: true });
    expect(segs.map((s: { index: number }) => s.index)).toEqual([0, 1, 2]);
    expect(segs[1]).toMatchObject({ chosen: "b", runnerUp: null, confidence: null, why: null, flagged: false });
  });
});

describe("candidateAngles", () => {
  const group = {
    members: [
      { id: "a", kind: "video", offsetSeconds: 0, durationSeconds: 100 },
      { id: "b", kind: "video", offsetSeconds: 0, durationSeconds: 100 },
      { id: "c", kind: "video", offsetSeconds: 50, durationSeconds: 100 }, // rolls at 50s
      { id: "aud", kind: "audio", offsetSeconds: 0, durationSeconds: 100 },
    ],
  };

  it("lists covering angles, chosen first, excluding ones without footage", () => {
    expect(candidateAngles(group, { atSeconds: 10, endSeconds: 14, chosen: "b" })).toEqual(["b", "a"]);
  });

  it("always includes the chosen angle even if its own coverage is borderline", () => {
    expect(candidateAngles(group, { atSeconds: 10, endSeconds: 14, chosen: "c" })).toEqual(["c", "a", "b"]);
  });

  it("handles a group with no members", () => {
    expect(candidateAngles({}, { atSeconds: 10, endSeconds: 14, chosen: "x" })).toEqual(["x"]);
  });
});

describe("applyReview", () => {
  it("applies changed picks and logs history with a timestamp + note", () => {
    const r = applyReview({ switches, choices: [{ index: 1, memberId: "c", note: "wide, switch it up" }], timestamp: "T" });
    expect(r.switches[1]).toEqual({ atSeconds: 4, memberId: "c" });
    expect(r.history).toEqual([{ atSeconds: 4, from: "b", to: "c", at: "T", note: "wide, switch it up" }]);
    // original untouched (immutability)
    expect(switches[1]).toEqual({ atSeconds: 4, memberId: "b" });
  });

  it("skips no-op / invalid choices and defaults note+timestamp to null, preserving prior history", () => {
    const prior = [{ atSeconds: 0, from: "x", to: "y", at: "T0", note: null }];
    const r = applyReview({
      switches,
      history: prior,
      choices: [
        null, // null choice
        { index: null, memberId: "z" }, // no index
        { index: -1, memberId: "z" }, // negative
        { index: 9, memberId: "z" }, // out of range
        { index: 0, memberId: "" }, // falsy memberId
        { index: 2, memberId: "a" }, // memberId === from (no-op)
        { index: 0, memberId: "b" }, // valid change, no note
      ],
    });
    expect(r.switches.map((s: { memberId: string }) => s.memberId)).toEqual(["b", "b", "a"]);
    expect(r.history).toEqual([
      { atSeconds: 0, from: "x", to: "y", at: "T0", note: null },
      { atSeconds: 0, from: "a", to: "b", at: null, note: null },
    ]);
  });
});

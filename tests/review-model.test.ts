import { describe, expect, it } from "vitest";
import {
  applyReview,
  candidateAngles,
  reviewSegments,
  splitSwitch,
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

  it("force-includes an unflagged cut by atSeconds (VS-74), tagged forced", () => {
    const segs = reviewSegments({ switches, rationale, timelineEnd: 12, forceKeys: [4] });
    expect(segs.map((s: { index: number }) => s.index)).toEqual([0, 1, 2]); // 1 now pulled in
    expect(segs[1]).toMatchObject({ index: 1, chosen: "b", flagged: false, forced: true });
    // a flagged cut named by forceKeys stays flagged (not marked forced)
    expect(segs[0]).toMatchObject({ index: 0, flagged: true, forced: false });
  });

  it("treats forceKeys as no-op when null/absent", () => {
    const segs = reviewSegments({ switches, rationale, timelineEnd: 12, forceKeys: null as unknown as number[] });
    expect(segs.map((s: { index: number }) => s.index)).toEqual([0, 2]);
    expect(segs[0].forced).toBe(false);
  });
});

describe("splitSwitch", () => {
  it("inserts a same-angle, flagged+manual cut into the region covering the time", () => {
    const r = splitSwitch({ switches, rationale, atSeconds: 6 });
    if (!r) throw new Error("expected a split");
    expect(r.index).toBe(2);
    expect(r).toMatchObject({ atSeconds: 6, memberId: "b" }); // region [4,9) is angle b
    expect(r.switches.map((s: { atSeconds: number }) => s.atSeconds)).toEqual([0, 4, 6, 9]);
    expect(r.switches[2]).toEqual({ atSeconds: 6, memberId: "b" });
    expect(r.rationale[2]).toMatchObject({ atSeconds: 6, memberId: "b", flagged: true, manual: true, why: "manual split" });
    // rationale stays aligned to the switch list
    expect(r.rationale.length).toBe(4);
    // original arrays untouched
    expect(switches.length).toBe(3);
  });

  it("carries the prior rationale across the insertion point", () => {
    const r = splitSwitch({ switches, rationale, atSeconds: 2 }); // splits region [0,4) → angle a
    if (!r) throw new Error("expected a split");
    expect(r.index).toBe(1);
    expect(r.switches[1]).toEqual({ atSeconds: 2, memberId: "a" });
    expect(r.rationale[0]).toMatchObject({ flagged: true }); // switch 0's rationale preserved before insert
    expect(r.rationale[2]).toMatchObject({ flagged: false }); // old switch-1 rationale shifted down
  });

  it("rounds the split time", () => {
    expect(splitSwitch({ switches, rationale, atSeconds: 6.00049 })?.atSeconds).toBe(6);
  });

  it("rejects invalid splits", () => {
    expect(splitSwitch({ switches: undefined as unknown as [], atSeconds: 6 })).toBeNull();
    expect(splitSwitch({ switches: [], atSeconds: 6 })).toBeNull();
    expect(splitSwitch({ switches, atSeconds: 0 })).toBeNull(); // non-positive
    expect(splitSwitch({ switches, atSeconds: 4.02 })).toBeNull(); // within epsilon of a cut
    expect(splitSwitch({ switches: [{ atSeconds: 5, memberId: "a" }], atSeconds: 3 })).toBeNull(); // before first cut
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

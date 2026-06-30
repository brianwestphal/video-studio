import { describe, expect, it } from "vitest";
import {
  angleCoversWindow,
  assembleWindowScore,
  buildSaliency,
  buildWindows,
  combineSaliency,
  DEFAULT_WEIGHTS,
  normalizeMotion,
  parseVisionReply,
  SALIENCY_VERSION,
  sectionBoundaries,
  selectVisionWindows,
  sourceTime,
  visionPrompt,
  // @ts-expect-error — JS module, no types
} from "../tools/visual-saliency.mjs";

describe("buildWindows", () => {
  it("makes an aligned grid, truncating the last window", () => {
    expect(buildWindows(5, 2)).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 2, endSeconds: 4 },
      { startSeconds: 4, endSeconds: 5 },
    ]);
  });
  it("defaults the window length", () => {
    expect(buildWindows(2)).toEqual([{ startSeconds: 0, endSeconds: 2 }]);
  });
  it("rejects a non-positive total or window length", () => {
    expect(() => buildWindows(0, 2)).toThrow(/totalSeconds/);
    expect(() => buildWindows(5, 0)).toThrow(/windowSeconds/);
  });
});

describe("sourceTime / angleCoversWindow", () => {
  const member = { offsetSeconds: 4, durationSeconds: 100 };
  it("maps the group clock into the angle's media (offset/rate)", () => {
    expect(sourceTime(10, member)).toBe(6);
    expect(sourceTime(10, { offsetSeconds: 2, rateCorrection: 2 })).toBe(4);
    expect(sourceTime(10, { correctedOffsetSeconds: 1 })).toBe(9);
    expect(sourceTime(10, {})).toBe(10);
  });
  it("knows when an angle has footage at a window center", () => {
    expect(angleCoversWindow({ startSeconds: 8, endSeconds: 10 }, member)).toBe(true); // center 9 → src 5
    expect(angleCoversWindow({ startSeconds: 0, endSeconds: 2 }, member)).toBe(false); // center 1 → src -3
    expect(angleCoversWindow({ startSeconds: 200, endSeconds: 202 }, member)).toBe(false); // past duration
    expect(angleCoversWindow({ startSeconds: 8, endSeconds: 10 }, { offsetSeconds: 0 })).toBe(true); // no duration → Infinity
  });
});

describe("normalizeMotion", () => {
  it("saturates a raw diff magnitude into 0..1", () => {
    expect(normalizeMotion(9, 18)).toBe(0.5);
    expect(normalizeMotion(50, 18)).toBe(1);
  });
  it("is zero for no motion or a degenerate scale", () => {
    expect(normalizeMotion(0)).toBe(0);
    expect(normalizeMotion(-3, 18)).toBe(0);
    expect(normalizeMotion(5, 0)).toBe(0);
  });
});

describe("parseVisionReply", () => {
  it("parses flat keys, clamps, and defaults", () => {
    const r = parseVisionReply('{"performer":0.9,"instrument":2,"motion":-1,"framing":0.5,"confidence":0.7,"labels":["singing",3]}');
    expect(r.scores).toEqual({ performer: 0.9, instrument: 1, motion: 0, framing: 0.5, presence: 0 });
    expect(r.labels).toEqual(["singing"]);
    expect(r.confidence).toBe(0.7);
  });
  it("parses a nested `scores` object inside code fences", () => {
    const r = parseVisionReply('```json\n{"scores":{"performer":0.4},"confidence":0.6}\n```');
    expect(r.scores.performer).toBe(0.4);
    expect(r.confidence).toBe(0.6);
  });
  it("defaults confidence to 0.5 and ignores junk", () => {
    expect(parseVisionReply("{}").confidence).toBe(0.5);
    expect(parseVisionReply("no json here").scores.performer).toBe(0);
    expect(parseVisionReply(42 as unknown as string).labels).toEqual([]);
    expect(parseVisionReply("{ unbalanced").scores.motion).toBe(0);
    expect(parseVisionReply("{bad json}").scores.motion).toBe(0);
  });
});

describe("combineSaliency", () => {
  it("is a normalized weighted sum", () => {
    expect(combineSaliency({ performer: 1, instrument: 1, motion: 1, framing: 1, presence: 1 })).toBe(1);
    expect(combineSaliency({ performer: 1 })).toBe(round3(DEFAULT_WEIGHTS.performer));
  });
  it("returns 0 when all weights are zero", () => {
    expect(combineSaliency({ performer: 1 }, {})).toBe(0);
  });
});

describe("selectVisionWindows", () => {
  const windows = buildWindows(10, 2); // 5 windows
  it("motion mode runs no vision", () => {
    expect(selectVisionWindows(windows, { mode: "motion" })).toEqual([]);
  });
  it("grid mode runs every window", () => {
    expect(selectVisionWindows(windows, { mode: "grid" })).toEqual([0, 1, 2, 3, 4]);
  });
  it("vision mode picks energetic windows", () => {
    // Only window 2 [4,6] clears the motion threshold; no boundaries given.
    expect(selectVisionWindows(windows, { mode: "vision", motion: [0, 0, 0.5, 0, 0], boundaries: [] })).toEqual([2]);
  });
  it("vision mode picks windows adjacent to a section boundary", () => {
    // Boundary 4.5 falls within ±1 s of windows 1 [2,4] and 2 [4,6]; no motion.
    expect(selectVisionWindows(windows, { mode: "vision", motion: [], boundaries: [4.5] })).toEqual([1, 2]);
  });
  it("caps to the highest-motion candidates, returned in order", () => {
    const sel = selectVisionWindows(windows, { mode: "grid", motion: [0.1, 0.9, 0.2, 0.8, 0.3], cap: 2 });
    expect(sel).toEqual([1, 3]);
  });
  it("treats missing motion as zero when capping", () => {
    // Only windows 0,1 have motion; the rest default to 0 and lose the cap race.
    expect(selectVisionWindows(windows, { mode: "grid", motion: [0.5, 0.4], cap: 2 })).toEqual([0, 1]);
  });
});

describe("sectionBoundaries", () => {
  it("collects section starts/ends, drops onsets, dedups + sorts", () => {
    const doc = {
      events: [
        { kind: "quiet", startSeconds: 0, endSeconds: 10.2 },
        { kind: "instrumental", startSeconds: 10.2, endSeconds: 30 },
        { kind: "onset", startSeconds: 12 },
        { kind: "vocal", startSeconds: 30 }, // no endSeconds (non-finite) → only start added
      ],
    };
    expect(sectionBoundaries(doc)).toEqual([0, 10.2, 30]);
  });
  it("handles a missing events list", () => {
    expect(sectionBoundaries(undefined)).toEqual([]);
  });
});

describe("assembleWindowScore / buildSaliency / visionPrompt", () => {
  it("assembles one window entry with a combined saliency", () => {
    const w = { startSeconds: 6, endSeconds: 8 };
    const entry = assembleWindowScore({ window: w, scores: { performer: 0.9, motion: 0.4 }, labels: ["singing", 7] as string[], confidence: 0.7, source: "vision" });
    expect(entry).toMatchObject({ startSeconds: 6, endSeconds: 8, source: "vision", confidence: 0.7, labels: ["singing"] });
    expect(entry.scores).toEqual({ performer: 0.9, instrument: 0, motion: 0.4, framing: 0, presence: 0 });
    expect(entry.saliency).toBeGreaterThan(0);
  });
  it("defaults to a motion-only entry", () => {
    const entry = assembleWindowScore({ window: { startSeconds: 0, endSeconds: 2 } });
    expect(entry.source).toBe("motion");
    expect(entry.confidence).toBe(0.5);
  });
  it("wraps angles into a versioned document", () => {
    const doc = buildSaliency({ groupId: "byam", angles: { "byam-cam-1": [] } });
    expect(doc).toEqual({ version: SALIENCY_VERSION, groupId: "byam", windowSeconds: 2.0, angles: { "byam-cam-1": [] } });
  });
  it("exposes the structured vision prompt", () => {
    expect(visionPrompt()).toContain('"performer"');
    expect(visionPrompt()).toContain("JSON");
  });
});

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

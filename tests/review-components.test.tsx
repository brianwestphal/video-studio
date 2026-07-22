import { describe, expect, it } from "vitest";

import { fmt, fmt1, ReviewHeader, ReviewSegments, sectionPercent, type ReviewSegment } from "../ui/review-components.js";

const segment: ReviewSegment = {
  index: 2, atSeconds: 4, endSeconds: 8, previewStart: 2, previewEnd: 10,
  chosen: "wide<&", pick: "close", note: "", why: "motion", confidence: null, forced: true,
  candidates: [{ id: "wide<&", url: "clip/wide.mp4", auto: true }, { id: "close", url: "clip/close.mp4" }],
};

describe("review kerf components", () => {
  it("formats time and clamps section geometry", () => {
    expect(fmt(65.9)).toBe("1:05");
    expect(fmt1(65.9)).toBe("1:05.9");
    expect(sectionPercent(segment, 0)).toBe(0);
    expect(sectionPercent(segment, 6)).toBe(50);
    expect(sectionPercent(segment, 20)).toBe(100);
    expect(sectionPercent({ ...segment, previewEnd: 2 }, 4)).toBe(0);
  });

  it("renders escaped, keyed controls with preserved video ownership", () => {
    const html = ReviewSegments({ segments: [segment, { ...segment, index: 3, forced: false, why: "", confidence: 0.8 }] }).toString();
    expect(html).toContain('data-key="2"');
    expect(html).toContain('data-key="wide&lt;&amp;"');
    expect(html).toContain("wide&lt;&amp;");
    expect(html).toContain('data-morph-skip=""');
    expect(html).toContain('data-action="pick"');
    expect(html).toContain("left:25%;width:50%");
  });

  it("renders optional header actions without inline handlers", () => {
    expect(ReviewHeader({ groupId: "g<&", count: 2, canRepropose: true, status: "ready" }).toString())
      .toContain('data-action="repropose"');
    expect(ReviewHeader({ groupId: "g", count: 0, canRepropose: false, status: "" }).toString())
      .not.toContain('data-action="repropose"');
  });
});

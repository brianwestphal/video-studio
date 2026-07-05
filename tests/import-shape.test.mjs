import { describe, it, expect } from "vitest";
import { formatDuration, describeImportShape } from "../desktop/sidecar/import-shape.mjs";

describe("import-shape — formatDuration", () => {
  it("formats M:SS and pads seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(239)).toBe("3:59");
    expect(formatDuration(65)).toBe("1:05");
  });
  it("adds an hours field past 3600s and pads minutes there", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(3600)).toBe("1:00:00");
  });
  it("clamps junk / negatives to 0:00", () => {
    expect(formatDuration(-5)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
    expect(formatDuration(undefined)).toBe("0:00");
  });
});

describe("import-shape — describeImportShape", () => {
  it("throws on an empty pool", () => {
    expect(() => describeImportShape({ sources: [] })).toThrow(/no analyzed sources/);
    expect(() => describeImportShape(null)).toThrow(/no analyzed sources/);
    expect(() => describeImportShape({})).toThrow(/no analyzed sources/);
  });

  it("one video → single-source shape", () => {
    const d = describeImportShape({ sources: [{ id: "a", path: "/f/a.mp4", durationSeconds: 134 }] });
    expect(d).toEqual({ shape: "single", sourceCount: 1, groups: [], summary: "1 video, 2:14, single-source" });
  });

  it("videos sharing a folder → one multi-cam group; duration is the longest angle", () => {
    const d = describeImportShape({
      sources: [
        { id: "cam1", path: "/shoot/cam1.mp4", durationSeconds: 239 },
        { id: "cam2", path: "/shoot/cam2.mp4", durationSeconds: 235 },
        { id: "cam3", path: "/shoot/cam3.mp4", durationSeconds: 238 },
        { id: "cam4", path: "/shoot/cam4.mp4", durationSeconds: 200 },
      ],
    });
    expect(d.shape).toBe("multicam");
    expect(d.sourceCount).toBe(4);
    expect(d.groups).toHaveLength(1);
    expect(d.groups[0].angleCount).toBe(4);
    expect(d.groups[0].durationSeconds).toBe(239);
    expect(d.summary).toBe("4 angles, 3:59, multi-cam");
  });

  it("a member without a durationSeconds counts as 0 (group duration = longest present)", () => {
    const d = describeImportShape({
      sources: [
        { id: "cam1", path: "/shoot/cam1.mp4", durationSeconds: 180 },
        { id: "cam2", path: "/shoot/cam2.mp4" }, // no duration
      ],
    });
    expect(d.shape).toBe("multicam");
    expect(d.groups[0].durationSeconds).toBe(180);
    expect(d.summary).toBe("2 angles, 3:00, multi-cam");
  });

  it("two separate folders → multi-group shape", () => {
    const d = describeImportShape({
      sources: [
        { id: "a1", path: "/ceremony/a1.mp4", durationSeconds: 600 },
        { id: "a2", path: "/ceremony/a2.mp4", durationSeconds: 590 },
        { id: "b1", path: "/reception/b1.mp4", durationSeconds: 300 },
        { id: "b2", path: "/reception/b2.mp4", durationSeconds: 310 },
      ],
    });
    expect(d.shape).toBe("multi-group");
    expect(d.groups).toHaveLength(2);
    expect(d.summary).toBe("2 groups (4 videos), multi-cam");
  });

  it("multiple videos with no grouping signal collapse to one 'all videos' group", () => {
    // Distinct folders AND distinct filename event-keys → no folder/filename group forms,
    // so the describer falls back to treating the whole pool as one group.
    const d = describeImportShape({
      sources: [
        { id: "x", path: "/one/alpha.mp4", durationSeconds: 100 },
        { id: "y", path: "/two/bravo.mp4", durationSeconds: 120 },
      ],
    });
    expect(d.shape).toBe("multicam");
    expect(d.groups[0].reason).toBe("all videos in the folder");
    expect(d.groups[0].memberIds).toEqual(["x", "y"]);
    expect(d.summary).toBe("2 angles, 2:00, multi-cam");
  });
});

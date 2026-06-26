import { describe, expect, it } from "vitest";

import { buildScenes, formatTimecode, parseFps, videoFrameCount } from "../src/scene-math.js";

describe("parseFps", () => {
  it("parses an integer rational like 24/1", () => {
    expect(parseFps("24/1")).toBe(24);
  });

  it("parses a fractional NTSC rate like 30000/1001", () => {
    expect(parseFps("30000/1001")).toBeCloseTo(29.97, 2);
  });

  it("parses a bare number with no denominator", () => {
    expect(parseFps("25")).toBe(25);
  });

  it("parses a decimal numerator", () => {
    expect(parseFps("23.976/1")).toBeCloseTo(23.976, 3);
  });

  it("trims surrounding whitespace", () => {
    expect(parseFps("  60/1  ")).toBe(60);
  });

  it("returns NaN for undefined", () => {
    expect(parseFps(undefined)).toBeNaN();
  });

  it("returns NaN for an unparseable string", () => {
    expect(parseFps("not-a-rate")).toBeNaN();
  });

  it("returns NaN for a zero denominator", () => {
    expect(parseFps("24/0")).toBeNaN();
  });
});

describe("formatTimecode", () => {
  it("formats frame 0 as the origin timecode", () => {
    expect(formatTimecode(0, 24)).toBe("00:00:00:00");
  });

  it("formats sub-second frames as the FF field", () => {
    expect(formatTimecode(23, 24)).toBe("00:00:00:23");
  });

  it("rolls one second over at exactly fps frames", () => {
    expect(formatTimecode(24, 24)).toBe("00:00:01:00");
  });

  it("formats minutes and seconds", () => {
    // 1m02s07f at 24fps = (62 * 24) + 7 = 1495 frames
    expect(formatTimecode(62 * 24 + 7, 24)).toBe("00:01:02:07");
  });

  it("formats hours", () => {
    // 1h at 24fps = 3600 * 24 = 86400 frames
    expect(formatTimecode(3600 * 24, 24)).toBe("01:00:00:00");
  });

  it("rounds non-integer fps to the nearest whole frame count", () => {
    // 29.97 rounds to 30; frame 30 → 1 second, 0 frames
    expect(formatTimecode(30, 29.97)).toBe("00:00:01:00");
  });
});

describe("videoFrameCount", () => {
  it("prefers the stream's nb_frames (as a string, the ffprobe shape)", () => {
    // Container says 734.122s*24=17618.9 frames, but the stream only has 17529.
    expect(videoFrameCount({ nbFrames: "17529", streamDuration: "730.375", formatDuration: 734.122, fps: 24 })).toBe(17529);
  });

  it("accepts nb_frames as a number", () => {
    expect(videoFrameCount({ nbFrames: 100, formatDuration: 10, fps: 24 })).toBe(100);
  });

  it("falls back to the stream duration when nb_frames is missing", () => {
    expect(videoFrameCount({ nbFrames: undefined, streamDuration: "730.375", formatDuration: 734.122, fps: 24 })).toBe(Math.floor(730.375 * 24));
  });

  it("ignores a non-positive / unparseable nb_frames", () => {
    expect(videoFrameCount({ nbFrames: "0", streamDuration: 10, formatDuration: 12, fps: 24 })).toBe(240);
    expect(videoFrameCount({ nbFrames: "N/A", streamDuration: 10, formatDuration: 12, fps: 24 })).toBe(240);
  });

  it("falls back to the container duration when the stream gives nothing usable", () => {
    expect(videoFrameCount({ nbFrames: undefined, streamDuration: undefined, formatDuration: 5, fps: 24 })).toBe(120);
    expect(videoFrameCount({ nbFrames: "N/A", streamDuration: "N/A", formatDuration: 5, fps: 24 })).toBe(120);
  });

  it("floors fractional duration-based counts (never overcounts past the last frame)", () => {
    expect(videoFrameCount({ streamDuration: 2.99, formatDuration: 2.99, fps: 24 })).toBe(71); // 71.76 -> 71
  });
});

describe("buildScenes", () => {
  it("returns a single full-length scene when there are no cuts", () => {
    expect(buildScenes([], 240, 24)).toEqual([{ startFrame: 0, endFrame: 240 }]);
  });

  it("always opens a scene at frame 0", () => {
    const scenes = buildScenes([5], 240, 24);
    expect(scenes[0]!.startFrame).toBe(0);
  });

  it("snaps cut times to the nearest frame", () => {
    // cut at 2.01s @ 24fps → round(48.24) = 48
    const scenes = buildScenes([2.01], 240, 24);
    expect(scenes).toEqual([
      { startFrame: 0, endFrame: 48 },
      { startFrame: 48, endFrame: 240 },
    ]);
  });

  it("merges cuts closer together than the minimum scene gap", () => {
    // minGap @ 24fps, 1.0s = 24 frames. Cuts at 1.0s (24f) and 1.2s (~29f) —
    // 29 - 24 = 5 < 24 → the second is dropped.
    const scenes = buildScenes([1.0, 1.2], 240, 24);
    expect(scenes).toEqual([
      { startFrame: 0, endFrame: 24 },
      { startFrame: 24, endFrame: 240 },
    ]);
  });

  it("honors a custom minSceneSec", () => {
    // With a 0.1s min gap (2.4 → 2 frames), the 1.2s cut survives.
    const scenes = buildScenes([1.0, 1.2], 240, 24, 0.1);
    expect(scenes).toEqual([
      { startFrame: 0, endFrame: 24 },
      { startFrame: 24, endFrame: 29 },
      { startFrame: 29, endFrame: 240 },
    ]);
  });

  it("drops cuts at or beyond the total frame count", () => {
    const scenes = buildScenes([100], 240, 24); // 100s @ 24fps = 2400 > 240
    expect(scenes).toEqual([{ startFrame: 0, endFrame: 240 }]);
  });

  it("sorts out-of-order cut times", () => {
    const scenes = buildScenes([4, 2], 240, 24); // 96f, 48f
    expect(scenes).toEqual([
      { startFrame: 0, endFrame: 48 },
      { startFrame: 48, endFrame: 96 },
      { startFrame: 96, endFrame: 240 },
    ]);
  });
});

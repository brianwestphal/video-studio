import { describe, expect, it } from "vitest";

import { buildManifest, framesToTimecode, overlayArgs, rebuildScript, segmentArgs } from "../tools/export-manifest.mjs";

const project = { fps: 24, width: 1920, height: 1080, name: "teaser" };

function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    project,
    clips: [
      { source: "/a.mov", in: 10, out: 12, audio: "keep" },
      { source: "/b.mov", in: 100, out: 101.5, audio: "silent" },
    ],
    ...overrides,
  };
}

describe("framesToTimecode", () => {
  it("formats frames as HH:MM:SS:FF", () => {
    expect(framesToTimecode(0, 24)).toBe("00:00:00:00");
    expect(framesToTimecode(24, 24)).toBe("00:00:01:00");
    expect(framesToTimecode(62 * 24 + 7, 24)).toBe("00:01:02:07");
  });
});

describe("buildManifest", () => {
  it("lays segments end-to-end with cumulative target ranges + provenance", () => {
    const m = buildManifest(baseSpec());
    expect(m.project).toMatchObject({ fps: 24, width: 1920, height: 1080, name: "teaser", totalSeconds: 3.5 });
    expect(m.project.totalTimecode).toBe("00:00:03:12"); // 3.5s @ 24 = 84 frames = 3s12f
    expect(m.segments).toHaveLength(2);
    expect(m.segments[0]).toMatchObject({
      index: 1, file: "segments/seg-001.mov", source: "/a.mov", sourceIn: 10, sourceOut: 12, audio: "keep", durationSeconds: 2,
    });
    expect(m.segments[0].target.start.timecode).toBe("00:00:00:00");
    expect(m.segments[0].target.end.timecode).toBe("00:00:02:00");
    // second clip starts where the first ends (2s) and is silent
    expect(m.segments[1].target.start.seconds).toBe(2);
    expect(m.segments[1].target.end.seconds).toBe(3.5);
    expect(m.segments[1].audio).toBe("silent");
  });

  it("places an overlay at its clip's target start + offset, duration probed", () => {
    const spec = baseSpec({ overlays: [{ file: "/cap.mov", overClip: 1, atOffset: 0.25, position: "center" }] });
    const m = buildManifest(spec, [0.8]); // probed overlay duration
    expect(m.overlays).toHaveLength(1);
    expect(m.overlays[0]).toMatchObject({ index: 1, file: "overlays/ov-001.mov", source: "/cap.mov", position: "center", overSegment: 2, durationSeconds: 0.8 });
    expect(m.overlays[0].target.start.seconds).toBe(2.25); // seg2 starts at 2 + 0.25
    expect(m.overlays[0].target.end.seconds).toBe(3.05);
  });

  it("defaults overClip to 0, atOffset to 0, position to lower-third, and honors an explicit duration", () => {
    const spec = baseSpec({ overlays: [{ file: "/c.mov", duration: 1.0 }] });
    const m = buildManifest(spec, [999]); // explicit duration wins over the probe
    expect(m.overlays[0]).toMatchObject({ overSegment: 1, position: "lower-third", durationSeconds: 1.0 });
    expect(m.overlays[0].target.start.seconds).toBe(0);
  });

  it("defaults the project name", () => {
    const spec = baseSpec();
    delete (spec.project as Record<string, unknown>).name;
    expect(buildManifest(spec).project.name).toBe("studio-export");
  });

  it("throws without a valid fps (empty project)", () => {
    expect(() => buildManifest({ project: {}, clips: [{ source: "x", in: 0, out: 1 }] })).toThrow(/project.fps/);
  });

  it("throws when the project key is absent entirely", () => {
    expect(() => buildManifest({ clips: [{ source: "x", in: 0, out: 1 }] })).toThrow(/project.fps/);
  });

  it("throws with an empty clips array", () => {
    expect(() => buildManifest({ project, clips: [] })).toThrow(/at least one clip/);
  });

  it("throws when the clips key is absent entirely", () => {
    expect(() => buildManifest({ project })).toThrow(/at least one clip/);
  });

  it("throws when a clip's out <= in", () => {
    expect(() => buildManifest({ project, clips: [{ source: "x", in: 5, out: 5 }] })).toThrow(/out .* <= in/);
  });

  it("throws when an overlay references a missing clip", () => {
    expect(() => buildManifest(baseSpec({ overlays: [{ file: "/c.mov", overClip: 9, duration: 1 }] }))).toThrow(/missing clip/);
  });

  it("throws when an overlay has no usable duration", () => {
    expect(() => buildManifest(baseSpec({ overlays: [{ file: "/c.mov" }] }), [])).toThrow(/no usable duration/);
  });
});

describe("segmentArgs", () => {
  it("extracts a kept-audio clip as ProRes 422 HQ", () => {
    const a = segmentArgs(project, { source: "/a.mov", in: 10, out: 12, audio: "keep" }, "/out/seg-001.mov");
    expect(a).toContain("prores_ks");
    expect(a).toContain("-profile:v");
    expect(a[a.indexOf("-profile:v") + 1]).toBe("3");
    expect(a).toContain("0:a:0?"); // maps source audio
    expect(a).toEqual(expect.arrayContaining(["-ss", "10", "-t", "2.000"]));
    expect(a.at(-1)).toBe("/out/seg-001.mov");
  });

  it("substitutes a silent track when audio is silent", () => {
    const a = segmentArgs(project, { source: "/b.mov", in: 100, out: 101.5, audio: "silent" }, "/out/seg-002.mov");
    expect(a.join(" ")).toContain("anullsrc=r=48000:cl=stereo");
    expect(a).toContain("1:a:0");
  });
});

describe("overlayArgs", () => {
  it("transcodes an alpha source file to ProRes 4444, trimmed", () => {
    const a = overlayArgs(project, "/cap.mov", 1.75, "/out/ov-001.mov");
    expect(a).toContain("/cap.mov");
    expect(a[a.indexOf("-profile:v") + 1]).toBe("4444");
    expect(a).toContain("yuva444p10le");
    expect(a).toEqual(expect.arrayContaining(["-t", "1.750", "-an"]));
  });
});

describe("rebuildScript", () => {
  it("concats segments and composites overlays at their offsets", () => {
    const m = buildManifest(baseSpec({ overlays: [{ file: "/cap.mov", overClip: 0, atOffset: 0.5, duration: 1 }] }));
    const sh = rebuildScript(m);
    expect(sh).toContain("#!/usr/bin/env bash");
    expect(sh).toContain("concat -safe 0 -i segments/list.txt");
    expect(sh).toContain("seg-001.mov");
    expect(sh).toContain("setpts=PTS-STARTPTS+0.5/TB"); // overlay at 0.5s
    expect(sh).toContain("overlay=0:0:eof_action=pass");
  });

  it("just renames the base track when there are no overlays", () => {
    const sh = rebuildScript(buildManifest(baseSpec()));
    expect(sh).toContain('mv "$OUT.base.mov" "$OUT"');
    expect(sh).not.toContain("filter_complex");
  });
});

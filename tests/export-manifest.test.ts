import { describe, expect, it } from "vitest";

import { audioTrackArgs, buildManifest, framesToTimecode, overlayArgs, rebuildScript, segmentArgs } from "../tools/export-manifest.mjs";

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

  it("scales a retimed clip's timeline duration by its rateCorrection", () => {
    // source span 2s at rate 2 → 4s on the timeline
    const m = buildManifest({ project, clips: [{ source: "/a.mov", in: 0, out: 2, audio: "silent", rateCorrection: 2 }] });
    expect(m.segments[0].durationSeconds).toBe(4);
    expect(m.segments[0].rateCorrection).toBe(2);
    expect(m.project.totalSeconds).toBe(4);
  });

  it("carries a master audioTrack (multi-cam), defaulting its duration to the timeline", () => {
    const m = buildManifest(baseSpec({ audioTrack: { source: "/r.wav", in: 0 } }));
    expect(m.audioTrack).toEqual({ file: "audio/master.mov", source: "/r.wav", sourceIn: 0, durationSeconds: m.project.totalSeconds });
  });

  it("honors an explicit audioTrack duration and in-point", () => {
    const m = buildManifest(baseSpec({ audioTrack: { source: "/r.wav", in: 1.25, durationSeconds: 9 } }));
    expect(m.audioTrack).toMatchObject({ sourceIn: 1.25, durationSeconds: 9 });
  });

  it("leaves audioTrack null when absent and throws on a zero-duration one", () => {
    expect(buildManifest(baseSpec()).audioTrack).toBe(null);
    expect(() => buildManifest({ project, clips: [{ source: "x", in: 0, out: 1 }], audioTrack: { source: "/r.wav", durationSeconds: 0 } })).toThrow(/audioTrack has no usable duration/);
  });
});

describe("audioTrackArgs", () => {
  it("extracts the master audio as PCM, trimmed, video dropped", () => {
    const a = audioTrackArgs({ source: "/r.wav", sourceIn: 2.5, durationSeconds: 12.5 }, "/out/audio/master.mov");
    expect(a).toEqual(expect.arrayContaining(["-ss", "2.5", "-i", "/r.wav", "-t", "12.500", "-vn", "-c:a", "pcm_s16le"]));
    expect(a.at(-1)).toBe("/out/audio/master.mov");
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

  it("applies a setpts retime when the clip carries a drift rateCorrection", () => {
    const a = segmentArgs(project, { source: "/a.mov", in: 0, out: 4, audio: "silent", rateCorrection: 1.0002 }, "/out/seg-001.mov");
    expect(a.join(" ")).toContain("setpts=1.0002*PTS");
  });
  it("omits the setpts retime when rateCorrection is 1 or absent", () => {
    expect(segmentArgs(project, { source: "/a.mov", in: 0, out: 4, audio: "silent", rateCorrection: 1 }, "/o.mov").join(" ")).not.toContain("setpts");
    expect(segmentArgs(project, { source: "/a.mov", in: 0, out: 4, audio: "silent" }, "/o.mov").join(" ")).not.toContain("setpts");
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

  it("muxes the master audio under silent video (multi-cam, no overlays)", () => {
    const sh = rebuildScript(buildManifest(baseSpec({ audioTrack: { source: "/r.wav", in: 0 } })));
    expect(sh).toContain('mv "$OUT.base.mov" "$OUT.video.mov"'); // video built first
    expect(sh).toContain('-i "$OUT.video.mov" -i "audio/master.mov"');
    expect(sh).toContain("-map 0:v:0 -map 1:a:0");
    expect(sh).toContain('rm -f "$OUT.video.mov"');
  });

  it("muxes the master audio after compositing overlays", () => {
    const sh = rebuildScript(buildManifest(baseSpec({
      overlays: [{ file: "/cap.mov", overClip: 0, atOffset: 0.5, duration: 1 }],
      audioTrack: { source: "/r.wav", in: 0 },
    })));
    expect(sh).toContain("filter_complex");
    expect(sh).toContain('-r "$FPS" -c:a pcm_s16le "$OUT.video.mov"'); // overlay output goes to video temp
    expect(sh).toContain('-i "$OUT.video.mov" -i "audio/master.mov"');
  });
});

describe("transitions + handles (VS-28)", () => {
  const clips = [
    { source: "/a.mov", in: 10, out: 12, audio: "keep" },
    { source: "/b.mov", in: 5, out: 8, audio: "keep" },
    { source: "/c.mov", in: 0.2, out: 3, audio: "keep" }, // in < handle → head clamps
  ];
  const spec3 = {
    project,
    clips,
    transitions: [
      { afterClip: 1, name: "Fade To Color", durationSeconds: 1.0, reason: "scene break" },
      { afterClip: 0, name: "Cross Dissolve", durationSeconds: 0.5 }, // out of order
    ],
    handleSeconds: 0.4,
  };

  it("records per-segment handles and normalizes + sorts transitions", () => {
    const m = buildManifest(spec3, [], [60, 60, 60]);
    expect(m.handleSeconds).toBe(0.5); // max(req 0.4, half of longest 1.0)
    expect(m.segments[0]).toMatchObject({ handleStartSeconds: 0.5, handleEndSeconds: 0.5, fileDurationSeconds: 3 });
    expect(m.segments[2].handleStartSeconds).toBe(0.2); // in 0.2 < 0.5 → clamped
    expect(m.transitions).toEqual([
      { afterSegment: 1, name: "Cross Dissolve", durationSeconds: 0.5 },
      { afterSegment: 2, name: "Fade To Color", durationSeconds: 1, reason: "scene break" },
    ]);
  });

  it("defaults the handle to 0.5s when unset", () => {
    const m = buildManifest({ project, clips, transitions: [{ afterClip: 0, name: "Cross Dissolve", durationSeconds: 0.5 }] }, [], [60, 60, 60]);
    expect(m.handleSeconds).toBe(0.5); // max(default 0.5, half 0.25)
  });

  it("falls back to the full handle when a source duration is unknown", () => {
    const m = buildManifest(spec3, [], []);
    expect(m.segments[0].handleEndSeconds).toBe(0.5);
  });

  it("skips handles for a drift-retimed clip", () => {
    const m = buildManifest({ ...spec3, clips: [{ ...clips[0], rateCorrection: 1.02 }, clips[1], clips[2]] }, [], [60, 60, 60]);
    expect(m.segments[0].handleStartSeconds).toBeUndefined();
    expect(m.segments[0].rateCorrection).toBe(1.02);
  });

  it("omits transitions/handles entirely when none are requested", () => {
    const m = buildManifest({ project, clips });
    expect(m.transitions).toBeUndefined();
    expect(m.handleSeconds).toBeUndefined();
    expect(m.segments[0].handleStartSeconds).toBeUndefined();
  });

  it("validates the transitions list", () => {
    const bad = (transitions: unknown[]) => () => buildManifest({ ...spec3, transitions }, [], [60, 60, 60]);
    expect(bad([{ afterClip: 2, name: "x", durationSeconds: 1 }])).toThrow(/not a cut/); // == clips-1
    expect(bad([{ afterClip: -1, name: "x", durationSeconds: 1 }])).toThrow(/not a cut/);
    expect(bad([{ afterClip: 1.5, name: "x", durationSeconds: 1 }])).toThrow(/not a cut/);
    expect(bad([{ afterClip: 0, name: "x", durationSeconds: 0 }])).toThrow(/positive durationSeconds/);
    expect(bad([{ afterClip: 0, durationSeconds: 1 }])).toThrow(/needs a name/);
    expect(bad([{ afterClip: 0, name: "x", durationSeconds: 1 }, { afterClip: 0, name: "y", durationSeconds: 1 }])).toThrow(/duplicates/);
  });

  it("segmentArgs bakes handles; rebuildScript trims them via inpoint/outpoint", () => {
    const m = buildManifest(spec3, [], [60, 60, 60]);
    const s0 = m.segments[0];
    const a = segmentArgs(project, clips[0], "/out/seg.mov", { start: s0.handleStartSeconds, end: s0.handleEndSeconds });
    expect(a).toEqual(expect.arrayContaining(["-ss", "9.500", "-t", "3.000"]));
    const sh = rebuildScript(m);
    expect(sh).toContain('printf "inpoint %s\\n" "0.500"');
    expect(sh).toContain('printf "outpoint %s\\n" "2.500"'); // head 0.5 + slot 2.0
  });
});

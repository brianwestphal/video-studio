import { describe, expect, it } from "vitest";

import { buildManifest } from "../tools/export-manifest.mjs";
import { audioTime, buildFcpxml, buildMulticamFcpxml, frameDuration, framesToTime, rationalTime } from "../tools/fcpxml.mjs";

describe("frameDuration", () => {
  it("maps integer rates to 1/fps", () => {
    expect(frameDuration(24)).toEqual({ num: 1, den: 24 });
    expect(frameDuration(30)).toEqual({ num: 1, den: 30 });
    expect(frameDuration(60)).toEqual({ num: 1, den: 60 });
  });
  it("maps NTSC rates to 1001/(round*1000)", () => {
    expect(frameDuration(29.97)).toEqual({ num: 1001, den: 30000 });
    expect(frameDuration(23.976)).toEqual({ num: 1001, den: 24000 });
    expect(frameDuration(59.94)).toEqual({ num: 1001, den: 60000 });
  });
  it("falls back to 1/round for an odd non-integer, non-NTSC rate", () => {
    expect(frameDuration(15.7)).toEqual({ num: 1, den: 16 });
  });
});

describe("rationalTime", () => {
  it("emits whole seconds without a denominator", () => {
    expect(rationalTime(2, 24)).toBe("2s"); // 48/24 → 2/1
    expect(rationalTime(0, 24)).toBe("0s");
  });
  it("reduces sub-second frame-aligned times", () => {
    expect(rationalTime(0.5, 24)).toBe("1/2s"); // 12/24 → 1/2
    expect(rationalTime(1.5, 24)).toBe("3/2s"); // 36/24 → 3/2
  });
  it("keeps NTSC times rational", () => {
    // 1s @ 29.97 = 30 frames → 30*1001/30000 = 30030/30000 → 1001/1000
    expect(rationalTime(1, 29.97)).toBe("1001/1000s");
  });
});

describe("audioTime", () => {
  it("renders whole seconds without a denominator", () => {
    expect(audioTime(20)).toBe("20s"); // 960000/48000 → 20/1
    expect(audioTime(0)).toBe("0s");
  });
  it("renders a sample-aligned fractional time as a reduced rational", () => {
    expect(audioTime(0.5)).toBe("1/2s"); // 24000/48000 → 1/2
    expect(audioTime(240.162)).toBe("120081/500s"); // the real BYAM WAV length
  });
  it("honors a non-default sample rate", () => {
    expect(audioTime(1, 44100)).toBe("1s");
    expect(audioTime(0.5, 44100)).toBe("1/2s");
  });
});

describe("framesToTime", () => {
  it("renders a whole frame count as an exact rational time", () => {
    expect(framesToTime(48, 24)).toBe("2s"); // 48/24 → 2/1
    expect(framesToTime(12, 24)).toBe("1/2s"); // 12/24 → 1/2
    expect(framesToTime(0, 24)).toBe("0s");
  });
  it("keeps NTSC frame counts rational", () => {
    // 1 frame @ 23.976 (24000/1001) → frameDuration 1001/24000
    expect(framesToTime(1, 24000 / 1001)).toBe("1001/24000s");
    expect(framesToTime(30, 29.97)).toBe("1001/1000s"); // 1s
  });
  it("is the integer-frame core that rationalTime rounds into", () => {
    expect(framesToTime(Math.round(1.5 * 24), 24)).toBe(rationalTime(1.5, 24));
  });
});

function sampleManifest() {
  return buildManifest(
    {
      project: { fps: 24, width: 1920, height: 1080, name: "teaser" },
      clips: [
        { source: "/a.mov", in: 10, out: 12, audio: "keep" },
        { source: "/b.mov", in: 100, out: 101.5, audio: "silent" },
      ],
      overlays: [{ file: "/cap.mov", overClip: 0, atOffset: 0.5, duration: 1 }],
    },
  );
}

describe("buildFcpxml", () => {
  const xml = buildFcpxml(sampleManifest(), (f) => `file:///export/${f}`);

  it("is a well-formed fcpxml document with the right header", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">')).toBe(true);
    expect(xml.trimEnd().endsWith("</fcpxml>")).toBe(true);
    // tags balance for the structural elements
    for (const tag of ["resources", "library", "event", "project", "sequence", "spine"]) {
      expect((xml.match(new RegExp(`<${tag}[ >]`, "g")) || []).length).toBe((xml.match(new RegExp(`</${tag}>`, "g")) || []).length);
    }
  });

  it("declares a frame-accurate format and one asset per exported clip", () => {
    expect(xml).toContain('<format id="r1" frameDuration="1/24s" width="1920" height="1080"');
    // 2 segments + 1 overlay = 3 assets (r2..r4)
    expect((xml.match(/<asset id="r/g) || []).length).toBe(3);
    expect(xml).toContain('<media-rep kind="original-media" src="file:///export/segments/seg-001.mov"/>');
    expect(xml).toContain("hasAudio=\"1\""); // segments have audio
  });

  it("lays segments on the spine at their target offsets", () => {
    expect(xml).toContain('<asset-clip ref="r2" offset="0s" name="seg-001" start="0s" duration="2s"');
    expect(xml).toContain('offset="2s" name="seg-002" start="0s" duration="3/2s"');
  });

  it("attaches the overlay as a connected clip (lane 1) at its parent-local offset", () => {
    // overlay at timeline 0.5s over seg-001 (starts at 0) → local offset 0.5s, lane 1
    expect(xml).toMatch(/<asset-clip ref="r4" lane="1" offset="1\/2s" name="ov-001" start="0s" duration="1s"\/>/);
    // and it is nested inside seg-001's asset-clip (which is therefore not self-closed)
    expect(xml).toContain('name="seg-001" start="0s" duration="2s" format="r1" tcFormat="NDF">');
  });

  it("self-closes a segment with no connected overlays", () => {
    expect(xml).toMatch(/name="seg-002"[^>]*duration="3\/2s"[^>]*\/>/);
  });
});

describe("buildFcpxml with a master audio track (multi-cam)", () => {
  const manifest = buildManifest({
    project: { fps: 24, width: 1920, height: 1080, name: "ceremony" },
    clips: [
      { source: "/a.mov", in: 0, out: 5, audio: "silent" },
      { source: "/b.mov", in: 5, out: 10, audio: "silent" },
    ],
    audioTrack: { source: "/r.wav", in: 0, durationSeconds: 10 },
  });
  const xml = buildFcpxml(manifest, (f) => `file:///export/${f}`);

  it("adds an audio-only asset for the master track", () => {
    // 2 segments + 1 audio = 3 assets; the audio asset has hasAudio but no hasVideo
    expect((xml.match(/<asset id="r/g) || []).length).toBe(3);
    expect(xml).toContain('<media-rep kind="original-media" src="file:///export/audio/master.mov"/>');
    expect(xml).toMatch(/<asset id="r4" name="master"[^>]*hasAudio="1"[^>]*\/?>/);
    expect(xml).not.toMatch(/name="master"[^>]*hasVideo/);
    // an audio-only asset must NOT carry a (video) format, or FCP rejects its edits
    expect(xml).not.toMatch(/name="master"[^>]*\bformat=/);
  });

  it("connects the master audio on lane -1 of the first segment, spanning the timeline", () => {
    expect(xml).toContain('<asset-clip ref="r4" lane="-1" offset="0s" name="master" start="0s" duration="10s"/>');
    // seg-001 is therefore not self-closed
    expect(xml).toContain('name="seg-001" start="0s" duration="5s" format="r1" tcFormat="NDF">');
  });
});

describe("buildMulticamFcpxml", () => {
  const group = {
    id: "ceremony",
    projectFps: 30,
    referenceId: "rec",
    masterAudioId: "rec",
    members: [
      { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 20, offsetSeconds: 0 },
      { id: "cam-a", path: "/a.mov", kind: "video", durationSeconds: 18, offsetSeconds: 2 },
      { id: "cam-b", path: "/b.mov", kind: "video", durationSeconds: 19, offsetSeconds: 1 },
    ],
  };
  const switches = [
    { atSeconds: 0, memberId: "cam-a" },
    { atSeconds: 8, memberId: "cam-b" },
  ];
  const xml = buildMulticamFcpxml(group, switches, { name: "cut", width: 1920, height: 1080 }, (p) => `file://${p}`);

  it("is a well-formed multicam fcpxml referencing the original media", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>')).toBe(true);
    for (const tag of ["resources", "library", "event", "project", "sequence", "spine", "media", "multicam"]) {
      expect((xml.match(new RegExp(`<${tag}[ >]`, "g")) || []).length).toBe((xml.match(new RegExp(`</${tag}>`, "g")) || []).length);
    }
    expect(xml).toContain('src="file:///r.wav"');
    expect(xml).toContain('src="file:///a.mov"');
  });

  it("gives video assets a format but leaves the audio-only asset format-less", () => {
    // the audio member (rec, r2) must NOT carry a video format — FCP would treat it
    // as video, find no frames, and reject its edits ("no respective media").
    expect(xml).toMatch(/<asset id="r2" name="r"[^>]*hasAudio="1"[^>]*>/);
    expect(xml).not.toMatch(/<asset id="r2"[^>]*format=/);
    // the video angles keep theirs
    expect(xml).toMatch(/<asset id="r3"[^>]*hasVideo="1"[^>]*format="r1"/);
  });

  it("declares one mc-angle per member at its sync offset", () => {
    expect((xml.match(/<mc-angle /g) || []).length).toBe(3);
    expect(xml).toContain('<mc-angle name="cam-a" angleID="cam-a">');
    // cam-a offset 2s (min offset is 0, no shift)
    expect(xml).toMatch(/angleID="cam-a">\s*<asset-clip ref="r3" offset="2s"/);
    expect(xml).toMatch(/angleID="rec">\s*<asset-clip ref="r2" offset="0s"/);
  });

  it("emits one mc-clip per switch span selecting VIDEO only from the active angle", () => {
    expect((xml.match(/<mc-clip /g) || []).length).toBe(2);
    expect(xml).toContain('<mc-clip ref="r5" offset="0s" name="cut" start="0s" duration="8s">');
    expect(xml).toContain('<mc-source angleID="cam-a" srcEnable="video"/>');
    // second span 8s → 20s (total = master duration)
    expect(xml).toContain('offset="8s" name="cut" start="8s" duration="12s">');
    expect(xml).toContain('<mc-source angleID="cam-b" srcEnable="video"/>');
    // audio is NOT routed through an mc-source (that imports silent) — see below
    expect(xml).not.toContain('srcEnable="audio"');
  });

  it("plays the master audio as a connected clip (lane -1) under the whole timeline", () => {
    // one connected master-audio clip, on the FIRST mc-clip only, spanning the
    // master duration — the reliable audio path (mirrors the flat export).
    const conn = xml.match(/<asset-clip ref="r2" lane="-1"[^>]*\/>/g) || [];
    expect(conn.length).toBe(1);
    expect(conn[0]).toBe('<asset-clip ref="r2" lane="-1" offset="0s" name="r" start="0s" duration="20s"/>');
    // it lives inside the first mc-clip (the 0s span), not the second
    expect(xml).toMatch(/start="0s" duration="8s">\s*<mc-source angleID="cam-a" srcEnable="video"\/>\s*<asset-clip ref="r2" lane="-1"/);
  });

  it("trims leading dead air with startSeconds (re-bases the timeline + audio to the trim point)", () => {
    // start the edit at group-time 8s: the second span (cam-b, 8→20) becomes the
    // whole timeline, re-based to start at 0 and lasting 12s.
    const x = buildMulticamFcpxml(group, switches, { name: "cut", width: 16, height: 9, startSeconds: 8 }, (p) => `file://${p}`);
    expect((x.match(/<mc-clip /g) || []).length).toBe(1); // the cam-a span (0→8) is dropped
    // re-based: timeline offset 0, but source still indexes the multicam at 8s
    expect(x).toContain('<mc-clip ref="r5" offset="0s" name="cut" start="8s" duration="12s">');
    expect(x).toContain('<mc-source angleID="cam-b" srcEnable="video"/>');
    // sequence shrinks to the trimmed length
    expect(x).toContain('<sequence format="r1" duration="12s"');
    // master audio now plays from group-time 8 (its own clock, masterOffset 0) for 12s
    expect(x).toContain('<asset-clip ref="r2" lane="-1" offset="0s" name="r" start="8s" duration="12s"/>');
  });

  it("clamps a span straddling the trim point and keeps the angle active there", () => {
    // trim at 4s: cam-a's span (0→8) is clipped to 4→8 and kept as the first clip
    const x = buildMulticamFcpxml(group, switches, { name: "cut", width: 16, height: 9, startSeconds: 4 }, (p) => `file://${p}`);
    expect((x.match(/<mc-clip /g) || []).length).toBe(2);
    expect(x).toContain('<mc-clip ref="r5" offset="0s" name="cut" start="4s" duration="4s">'); // cam-a 4→8 re-based
    expect(x).toMatch(/angleID="cam-a"/);
    expect(x).toContain('<sequence format="r1" duration="16s"'); // 20 - 4
  });

  it("drops a zero-length span (a switch exactly at the timeline end)", () => {
    // cam-b switches in at 20s, but total is 20s → its span is empty and dropped.
    const x = buildMulticamFcpxml(group, [{ atSeconds: 0, memberId: "cam-a" }, { atSeconds: 20, memberId: "cam-b" }], { name: "cut", width: 16, height: 9 }, (p) => `file://${p}`);
    expect((x.match(/<mc-clip /g) || []).length).toBe(1);
    expect(x).toContain('<mc-source angleID="cam-a" srcEnable="video"/>');
    // cam-b is still an angle in the multicam media, but no spine clip selects it
    expect(x).not.toContain('<mc-source angleID="cam-b"');
  });

  it("rejects a startSeconds outside [0, total)", () => {
    expect(() => buildMulticamFcpxml(group, switches, { width: 1, height: 1, startSeconds: -1 }, (p) => p)).toThrow(/startSeconds/);
    expect(() => buildMulticamFcpxml(group, switches, { width: 1, height: 1, startSeconds: 20 }, (p) => p)).toThrow(/startSeconds/);
  });

  it("shifts negative offsets so the earliest angle sits at 0", () => {
    const g = {
      ...group,
      members: [
        { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 20, offsetSeconds: 0 },
        { id: "cam-early", path: "/e.mov", kind: "video", durationSeconds: 20, offsetSeconds: -3 },
      ],
    };
    const x = buildMulticamFcpxml(g, [{ atSeconds: 0, memberId: "cam-early" }], { name: "n", width: 16, height: 9 }, (p) => `file://${p}`);
    // earliest angle (cam-early, -3) shifts to 0; rec (0) shifts to 3
    expect(x).toMatch(/angleID="cam-early">\s*<asset-clip[^>]*offset="0s"/);
    expect(x).toMatch(/angleID="rec">\s*<asset-clip[^>]*offset="3s"/);
    // and the mc-clip start is shifted (0 + shift 3)
    expect(x).toContain('start="3s"');
  });

  it("defaults to a single span on the first video angle when no switches", () => {
    const x = buildMulticamFcpxml(group, [], { name: "n", width: 16, height: 9 }, (p) => `file://${p}`);
    expect((x.match(/<mc-clip /g) || []).length).toBe(1);
    expect(x).toContain('<mc-source angleID="cam-a" srcEnable="video"/>'); // first video member
    expect(x).toContain('duration="20s"'); // spans the whole master duration
  });

  it("honors an explicit totalSeconds", () => {
    const x = buildMulticamFcpxml(group, [{ atSeconds: 0, memberId: "cam-a" }], { name: "n", width: 16, height: 9, totalSeconds: 6 }, (p) => `file://${p}`);
    expect(x).toContain('<sequence format="r1" duration="6s"');
  });

  it("throws on a missing master or unknown switch member", () => {
    expect(() => buildMulticamFcpxml({ ...group, masterAudioId: "ghost" }, switches, { width: 1, height: 1 }, (p) => p)).toThrow(/master audio member/);
    expect(() => buildMulticamFcpxml(group, [{ atSeconds: 0, memberId: "ghost" }], { width: 1, height: 1 }, (p) => p)).toThrow(/unknown memberId/);
  });

  it("throws when no positive total is available", () => {
    const g = { ...group, members: [{ id: "rec", path: "/r.wav", kind: "audio", offsetSeconds: 0 }] };
    expect(() => buildMulticamFcpxml(g, [], { width: 1, height: 1 }, (p) => p)).toThrow(/positive totalSeconds/);
  });

  it("falls back to the group id for the name when none is given", () => {
    const x = buildMulticamFcpxml(group, [{ atSeconds: 0, memberId: "cam-a" }], { width: 16, height: 9 }, (p) => `file://${p}`);
    expect(x).toContain('<project name="ceremony">');
    expect(x).toContain('name="ceremony multicam"');
  });

  it("tolerates a member with no duration and an all-audio group", () => {
    const g = {
      id: "audio-only",
      projectFps: 30,
      masterAudioId: "rec",
      members: [
        { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 5, offsetSeconds: 0 },
        { id: "mic2", path: "/m.wav", kind: "audio" }, // no durationSeconds, no offsetSeconds
      ],
    };
    const x = buildMulticamFcpxml(g, [], { width: 16, height: 9 }, (p) => `file://${p}`);
    // no video member → first span defaults to the first member (rec)
    expect(x).toContain('<mc-source angleID="rec" srcEnable="video"/>');
    expect((x.match(/<mc-angle /g) || []).length).toBe(2);
  });

  it("falls back to the timeline total for the connected audio when the master has no duration", () => {
    const g = {
      id: "no-dur",
      projectFps: 30,
      masterAudioId: "rec",
      members: [
        { id: "rec", path: "/r.wav", kind: "audio", offsetSeconds: 0 }, // no durationSeconds
        { id: "cam-a", path: "/a.mov", kind: "video", durationSeconds: 12, offsetSeconds: 0 },
      ],
    };
    // explicit total drives both the sequence and the connected master-audio span
    const x = buildMulticamFcpxml(g, [{ atSeconds: 0, memberId: "cam-a" }], { width: 16, height: 9, totalSeconds: 9 }, (p) => `file://${p}`);
    expect(x).toContain('<asset-clip ref="r2" lane="-1" offset="0s" name="r" start="0s" duration="9s"/>');
  });

  it("lays the spine on exactly contiguous frame boundaries at non-integer fps", () => {
    // Regression: at 23.976 fps, rounding each clip's offset and duration
    // independently from seconds left ±1-frame gaps/overlaps on the spine, which
    // FCP mis-positions. Frame-aligned clips must abut exactly and end at the
    // sequence duration.
    const fps = 24000 / 1001;
    const g = {
      id: "ntsc",
      projectFps: fps,
      masterAudioId: "rec",
      members: [
        { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 30, offsetSeconds: 0 },
        { id: "cam-a", path: "/a.mov", kind: "video", durationSeconds: 30, offsetSeconds: 0 },
        { id: "cam-b", path: "/b.mov", kind: "video", durationSeconds: 30, offsetSeconds: 0 },
      ],
    };
    const x = buildMulticamFcpxml(
      g,
      [{ atSeconds: 0, memberId: "cam-a" }, { atSeconds: 7, memberId: "cam-b" }, { atSeconds: 21, memberId: "cam-a" }],
      { name: "n", width: 16, height: 9, totalSeconds: 30 },
      (p) => `file://${p}`,
    );
    // Decode a rational FCP time string to a whole frame count.
    const frames = (s: string) => {
      const m = s.match(/^(\d+)(?:\/(\d+))?s$/)!;
      const num = Number(m[1]);
      const den = m[2] ? Number(m[2]) : 1;
      // den is the frameDuration denominator (24000) scaled; num/den seconds * fps frames.
      return Math.round((num / den) * fps);
    };
    const clips = [...x.matchAll(/<mc-clip[^>]*offset="([^"]+)"[^>]*start="([^"]+)"[^>]*duration="([^"]+)"/g)];
    expect(clips.length).toBe(3);
    let cursor = 0;
    for (const c of clips) {
      expect(frames(c[1])).toBe(cursor); // each offset == running frame sum (no gap/overlap)
      cursor += frames(c[3]);
    }
    expect(cursor).toBe(frames(x.match(/<sequence[^>]*duration="([^"]+)"/)![1])); // fills the sequence
  });
});

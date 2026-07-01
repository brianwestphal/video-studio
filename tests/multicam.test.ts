import { describe, expect, it } from "vitest";

import {
  buildGroupManifest,
  classifySync,
  DRIFT_WARN_PPM,
  expandMulticamGroup,
  resolveAngleCuts,
  selectReference,
  switchesFromDoc,
} from "../tools/multicam.mjs";

describe("classifySync", () => {
  it("gates on accept / reject thresholds", () => {
    expect(classifySync(0.9)).toBe("auto");
    expect(classifySync(0.6)).toBe("review");
    expect(classifySync(0.2)).toBe("manual");
  });
  it("respects custom thresholds", () => {
    expect(classifySync(0.7, { accept: 0.6, reject: 0.3 })).toBe("auto");
  });
});

describe("selectReference", () => {
  it("throws on an empty group", () => {
    expect(() => selectReference([])).toThrow(/at least one member/);
  });
  it("prefers the longest audio-only member", () => {
    const ref = selectReference([
      { id: "cam-a", kind: "video", durationSeconds: 100 },
      { id: "rec", kind: "audio", durationSeconds: 90 },
      { id: "rec2", kind: "audio", durationSeconds: 120 },
    ]);
    expect(ref.id).toBe("rec2");
  });
  it("falls back to the longest member when none are audio-only", () => {
    const ref = selectReference([
      { id: "cam-a", kind: "video", durationSeconds: 100 },
      { id: "cam-b", kind: "video", durationSeconds: 200 },
    ]);
    expect(ref.id).toBe("cam-b");
  });
  it("treats a missing duration as zero", () => {
    const ref = selectReference([{ id: "x", kind: "video" }, { id: "y", kind: "video", durationSeconds: 5 }]);
    expect(ref.id).toBe("y");
  });
});

describe("buildGroupManifest", () => {
  const members = [
    { id: "cam-a", path: "/a.mov", kind: "video", fps: 29.97, durationSeconds: 100, offsetSeconds: 2.5, confidence: 0.91, peakRatio: 4 },
    { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 110, offsetSeconds: 0, confidence: 0.99 },
  ];
  it("anchors the reference and picks the audio-only master", () => {
    const m = buildGroupManifest({ id: "g", projectFps: 30, members });
    expect(m.referenceId).toBe("rec");
    expect(m.masterAudioId).toBe("rec");
    const rec = m.members.find((x) => x.id === "rec")!;
    expect(rec.offsetSeconds).toBe(0);
    expect(rec.confidence).toBe(1);
    expect(rec.sync).toBe("reference");
  });
  it("classifies non-reference members and fills defaults", () => {
    const m = buildGroupManifest({ id: "g", projectFps: 30, members });
    const cam = m.members.find((x) => x.id === "cam-a")!;
    expect(cam.offsetSeconds).toBe(2.5);
    expect(cam.sync).toBe("auto");
    expect(cam.fps).toBe(29.97);
    expect(cam.peakRatio).toBe(4);
    expect(cam.driftWarning).toBe(false);
  });
  it("keeps an explicit sync disposition and flags excessive drift", () => {
    const m = buildGroupManifest({
      id: "g",
      projectFps: 30,
      members: [
        { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 110, offsetSeconds: 0, confidence: 0.99 },
        { id: "cam", path: "/c.mov", kind: "video", durationSeconds: 100, offsetSeconds: 1, confidence: 0.4, sync: "manual", driftPpm: DRIFT_WARN_PPM + 50 },
      ],
    });
    const cam = m.members.find((x) => x.id === "cam")!;
    expect(cam.sync).toBe("manual");
    expect(cam.driftWarning).toBe(true);
    expect(cam.driftPpm).toBe(DRIFT_WARN_PPM + 50);
  });
  it("carries drift rate correction + start-anchored offset, defaulting the reference", () => {
    const m = buildGroupManifest({
      id: "g",
      projectFps: 30,
      members: [
        { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 2000, offsetSeconds: 0, confidence: 0.99 },
        { id: "cam", path: "/c.mov", kind: "video", durationSeconds: 1900, offsetSeconds: 1.5, confidence: 0.9, driftPpm: 200, rateCorrection: 1.0002, correctedOffsetSeconds: 1.3 },
      ],
    });
    const cam = m.members.find((x) => x.id === "cam")!;
    expect(cam.rateCorrection).toBe(1.0002);
    expect(cam.correctedOffsetSeconds).toBe(1.3);
    expect(cam.driftWarning).toBe(true);
    const rec = m.members.find((x) => x.id === "rec")!;
    expect(rec.rateCorrection).toBe(1);
    expect(rec.correctedOffsetSeconds).toBe(0);
  });
  it("defaults rate correction to 1 and corrected offset to null when absent", () => {
    const m = buildGroupManifest({ id: "g", projectFps: 30, members });
    const cam = m.members.find((x) => x.id === "cam-a")!;
    expect(cam.rateCorrection).toBe(1);
    expect(cam.correctedOffsetSeconds).toBe(null);
  });
  it("uses the reference as master audio when there is no single audio-only member", () => {
    const m = buildGroupManifest({
      id: "g",
      projectFps: 30,
      members: [
        { id: "cam-a", path: "/a.mov", kind: "video", durationSeconds: 200, offsetSeconds: 0, confidence: 0.9 },
        { id: "cam-b", path: "/b.mov", kind: "video", offsetSeconds: 1.2, confidence: 0.8 },
      ],
    });
    expect(m.referenceId).toBe("cam-a");
    expect(m.masterAudioId).toBe("cam-a");
    const a = m.members.find((x) => x.id === "cam-a")!;
    expect(a.durationSeconds).toBe(200);
    expect(a.fps).toBe(null);
    // cam-b carries no durationSeconds → manifest normalizes it to null
    expect(m.members.find((x) => x.id === "cam-b")!.durationSeconds).toBe(null);
  });
});

describe("resolveAngleCuts", () => {
  const members = [
    { id: "cam-a", offsetSeconds: 0, durationSeconds: 100 },
    { id: "cam-b", offsetSeconds: 2, durationSeconds: 100 },
  ];
  it("splits the timeline at switch points and maps to source time", () => {
    const segs = resolveAngleCuts(
      [
        { atSeconds: 0, memberId: "cam-a" },
        { atSeconds: 10, memberId: "cam-b" },
      ],
      members,
      { totalSeconds: 20 },
    );
    expect(segs).toEqual([
      { memberId: "cam-a", timelineInSeconds: 0, timelineOutSeconds: 10, sourceInSeconds: 0, sourceOutSeconds: 10 },
      { memberId: "cam-b", timelineInSeconds: 10, timelineOutSeconds: 20, sourceInSeconds: 8, sourceOutSeconds: 18 },
    ]);
  });
  it("sorts unordered switches", () => {
    const segs = resolveAngleCuts(
      [
        { atSeconds: 10, memberId: "cam-b" },
        { atSeconds: 0, memberId: "cam-a" },
      ],
      members,
      { totalSeconds: 20 },
    );
    expect(segs[0].memberId).toBe("cam-a");
  });
  it("defaults a member offset of zero when absent", () => {
    const segs = resolveAngleCuts(
      [{ atSeconds: 0, memberId: "x" }],
      [{ id: "x" }],
      { totalSeconds: 5 },
    );
    expect(segs[0].sourceInSeconds).toBe(0);
  });
  it("throws on an empty switch list", () => {
    expect(() => resolveAngleCuts([], members, { totalSeconds: 10 })).toThrow(/at least one switch/);
  });
  it("throws on an unknown memberId", () => {
    expect(() => resolveAngleCuts([{ atSeconds: 0, memberId: "ghost" }], members, { totalSeconds: 10 })).toThrow(/unknown memberId/);
  });
});

describe("expandMulticamGroup", () => {
  const group = {
    id: "ceremony",
    projectFps: 30,
    referenceId: "rec",
    masterAudioId: "rec",
    members: [
      { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 20, offsetSeconds: 0 },
      { id: "cam-a", path: "/a.mov", kind: "video", durationSeconds: 20, offsetSeconds: 2 },
      { id: "cam-b", path: "/b.mov", kind: "video", durationSeconds: 20, offsetSeconds: 0 },
    ],
  };
  const switches = [
    { atSeconds: 0, memberId: "cam-a" },
    { atSeconds: 5, memberId: "cam-b" },
  ];
  it("expands switches into silent video clips + a master-audio track", () => {
    const spec = expandMulticamGroup(group, switches, { name: "cut", width: 1920, height: 1080 });
    expect(spec.project).toEqual({ name: "cut", fps: 30, width: 1920, height: 1080 });
    expect(spec.clips).toEqual([
      { source: "/a.mov", in: -2, out: 3, audio: "silent" }, // cam-a offset 2 → source = timeline - 2
      { source: "/b.mov", in: 5, out: 20, audio: "silent" },
    ]);
    expect(spec.audioTrack).toEqual({ source: "/r.wav", in: 0, durationSeconds: 20 });
  });
  it("defaults the project name to the group id and total to the master duration", () => {
    const spec = expandMulticamGroup(group, switches, { width: 16, height: 9 });
    expect(spec.project.name).toBe("ceremony");
    expect(spec.audioTrack.durationSeconds).toBe(20);
  });
  it("honors an explicit totalSeconds and a master offset", () => {
    const g2 = { ...group, masterAudioId: "cam-a" }; // master started 2s late
    const spec = expandMulticamGroup(g2, switches, { width: 16, height: 9, totalSeconds: 12 });
    expect(spec.audioTrack).toEqual({ source: "/a.mov", in: -2, durationSeconds: 12 });
  });
  it("retimes a drifting member: source span shrinks by rate and the clip is tagged", () => {
    const drifting = {
      ...group,
      members: [
        { id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 20, offsetSeconds: 0 },
        { id: "cam-a", path: "/a.mov", kind: "video", durationSeconds: 20, offsetSeconds: 2, rateCorrection: 2, correctedOffsetSeconds: 2 },
      ],
    };
    const spec = expandMulticamGroup(drifting, [{ atSeconds: 0, memberId: "cam-a" }], { width: 16, height: 9, totalSeconds: 10 });
    // source = (timeline - correctedOffset) / rate = (0-2)/2 .. (10-2)/2 = -1 .. 4
    expect(spec.clips[0]).toEqual({ source: "/a.mov", in: -1, out: 4, audio: "silent", rateCorrection: 2 });
  });
  it("throws when the master audio member is missing", () => {
    expect(() => expandMulticamGroup({ ...group, masterAudioId: "ghost" }, switches, { width: 1, height: 1 })).toThrow(/master audio member/);
  });
  it("throws when no positive total is available", () => {
    const g = { ...group, members: [{ id: "rec", path: "/r.wav", kind: "audio", offsetSeconds: 0 }] };
    expect(() => expandMulticamGroup(g, [{ atSeconds: 0, memberId: "rec" }], { width: 1, height: 1 })).toThrow(/positive totalSeconds/);
  });
  it("treats a master with no offset field as offset 0", () => {
    const g = { ...group, members: [{ id: "rec", path: "/r.wav", kind: "audio", durationSeconds: 8 }, ...group.members.slice(1)] };
    const spec = expandMulticamGroup(g, [{ atSeconds: 0, memberId: "rec" }], { width: 1, height: 1 });
    expect(spec.audioTrack.in).toBe(0);
  });
});

describe("switchesFromDoc", () => {
  it("extracts the switches array from a propose-switches document", () => {
    const doc = {
      version: 1,
      groupId: "g",
      switches: [
        { atSeconds: 0, memberId: "a" },
        { atSeconds: 4, memberId: "b" },
      ],
      rationale: [{ atSeconds: 0, memberId: "a", why: "x" }],
    };
    expect(switchesFromDoc(doc)).toEqual([
      { atSeconds: 0, memberId: "a" },
      { atSeconds: 4, memberId: "b" },
    ]);
  });

  it("accepts a bare array and normalizes away extra keys", () => {
    const arr = [{ atSeconds: 2, memberId: "a", why: "kept out" }];
    expect(switchesFromDoc(arr)).toEqual([{ atSeconds: 2, memberId: "a" }]);
  });

  it("returns [] for absent/nonsense input", () => {
    expect(switchesFromDoc(null)).toEqual([]);
    expect(switchesFromDoc({})).toEqual([]);
    expect(switchesFromDoc({ switches: "nope" })).toEqual([]);
  });

  it("drops invalid entries (null, NaN atSeconds, empty/non-string memberId)", () => {
    const doc = {
      switches: [
        null,
        { atSeconds: Number.NaN, memberId: "a" },
        { atSeconds: 1, memberId: "" },
        { atSeconds: 2, memberId: 5 },
        { atSeconds: 3, memberId: "ok" },
      ],
    };
    expect(switchesFromDoc(doc)).toEqual([{ atSeconds: 3, memberId: "ok" }]);
  });
});

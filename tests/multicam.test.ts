import { describe, expect, it } from "vitest";

import {
  buildGroupManifest,
  atempoChain,
  clamp,
  classifySync,
  condition,
  crossCorrelate,
  crossCorrelatePhat,
  dot,
  driftCorrection,
  DRIFT_WARN_PPM,
  envelope,
  expandMulticamGroup,
  fftInPlace,
  findOffset,
  fitDrift,
  nextPow2,
  offsetSeconds,
  parabolicVertex,
  removeMean,
  resolveAngleCuts,
  selectReference,
  signedLag,
} from "../tools/multicam.mjs";

// A deterministic pseudo-random signal (no Math.random so tests are stable).
function noise(n: number, seed = 1): Float64Array {
  const out = new Float64Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
}

// Build `clip` as `ref` shifted so the clip "starts" `delay` samples later than
// the reference: clip[i] = ref[i + delay]. Out-of-range reads become 0.
function shift(ref: Float64Array, delay: number): Float64Array {
  const out = new Float64Array(ref.length);
  for (let i = 0; i < ref.length; i++) {
    const j = i + delay;
    out[i] = j >= 0 && j < ref.length ? ref[j] : 0;
  }
  return out;
}

describe("numeric helpers", () => {
  it("clamp bounds a value", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
  it("nextPow2 rounds up to a power of two", () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(5)).toBe(8);
    expect(nextPow2(8)).toBe(8);
  });
  it("dot sums products", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });
  it("removeMean centers a signal and tolerates empty input", () => {
    const out = removeMean([1, 2, 3]);
    expect(Array.from(out)).toEqual([-1, 0, 1]);
    expect(removeMean([]).length).toBe(0);
  });
});

describe("envelope", () => {
  it("rectifies and box-smooths, and tolerates empty input", () => {
    const e = envelope([-1, 1, -1, 1], 2);
    // first sample: |−1| with one-sample window = 1; then running mean of |.|
    expect(e[0]).toBeCloseTo(1, 6);
    expect(e[3]).toBeCloseTo(1, 6);
    expect(envelope([], 4).length).toBe(0);
  });
  it("clamps the window to at least 1", () => {
    const e = envelope([2, -4], 0);
    expect(e[0]).toBeCloseTo(2, 6);
    expect(e[1]).toBeCloseTo(4, 6);
  });
});

describe("condition", () => {
  it("defaults to envelope then mean-removal", () => {
    const c = condition([1, -1, 1, -1]);
    const mean = c.reduce((a, b) => a + b, 0) / c.length;
    expect(mean).toBeCloseTo(0, 6);
  });
  it("supports the raw waveform feature", () => {
    const c = condition([1, 2, 3], { feature: "raw" });
    expect(Array.from(c)).toEqual([-1, 0, 1]);
  });
});

describe("fftInPlace", () => {
  it("matches a hand-computed DFT for N=4", () => {
    const re = new Float64Array([1, 2, 3, 4]);
    const im = new Float64Array(4);
    fftInPlace(re, im);
    // DC bin = sum = 10
    expect(re[0]).toBeCloseTo(10, 6);
    expect(im[0]).toBeCloseTo(0, 6);
    // Nyquist bin = 1-2+3-4 = -2
    expect(re[2]).toBeCloseTo(-2, 6);
  });
  it("ifft(fft(x)) round-trips", () => {
    const orig = noise(16, 7);
    const re = Float64Array.from(orig);
    const im = new Float64Array(16);
    fftInPlace(re, im);
    fftInPlace(re, im, true);
    for (let i = 0; i < 16; i++) expect(re[i]).toBeCloseTo(orig[i], 6);
  });
});

describe("crossCorrelate / signedLag", () => {
  it("maps circular indices to signed lags", () => {
    expect(signedLag(1, 8)).toBe(1);
    expect(signedLag(7, 8)).toBe(-1);
    expect(signedLag(4, 8)).toBe(-4);
  });
  it("peaks at zero lag for identical signals", () => {
    const a = noise(64, 3);
    const c = crossCorrelate(a, a);
    let bestIdx = 0;
    for (let i = 0; i < c.length; i++) if (c[i] > c[bestIdx]) bestIdx = i;
    expect(signedLag(bestIdx, c.length)).toBe(0);
  });
});

describe("findOffset", () => {
  it("recovers a positive offset (clip started later)", () => {
    const ref = noise(256, 11);
    const clip = shift(ref, 20); // clip[i] = ref[i+20]
    const r = findOffset(ref, clip);
    expect(r.offsetSamples).toBe(20);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
  it("recovers a negative offset (clip started earlier)", () => {
    const ref = noise(256, 11);
    const clip = shift(ref, -15);
    const r = findOffset(ref, clip);
    expect(r.offsetSamples).toBe(-15);
  });
  it("reports low confidence for unrelated signals", () => {
    const r = findOffset(noise(256, 1), noise(256, 999));
    expect(r.confidence).toBeLessThan(0.5);
  });
  it("honors maxLagSamples to reject implausible offsets", () => {
    const ref = noise(256, 11);
    const clip = shift(ref, 40);
    const r = findOffset(ref, clip, { maxLagSamples: 10 });
    expect(Math.abs(r.offsetSamples)).toBeLessThanOrEqual(10);
  });
  it("returns zero confidence and infinite peakRatio for empty signals", () => {
    const r = findOffset(new Float64Array(4), new Float64Array(4));
    expect(r.confidence).toBe(0);
    expect(r.peakRatio).toBe(Infinity);
  });
  it("offsetSeconds divides by the sample rate", () => {
    const ref = noise(256, 5);
    const clip = shift(ref, 16);
    const r = offsetSeconds(ref, clip, 8000);
    expect(r.seconds).toBeCloseTo(16 / 8000, 9);
  });
});

describe("parabolicVertex", () => {
  it("locates the vertex of a symmetric peak at zero", () => {
    expect(parabolicVertex(0, 1, 0)).toBeCloseTo(0, 9);
  });
  it("shifts toward the higher neighbor", () => {
    // parabola peaking between 0 and +1
    expect(parabolicVertex(0, 1, 0.5)).toBeGreaterThan(0);
    expect(parabolicVertex(0.5, 1, 0)).toBeLessThan(0);
  });
  it("returns zero for a flat/degenerate triple", () => {
    expect(parabolicVertex(1, 1, 1)).toBe(0);
  });
  it("clamps to the (-0.5, 0.5) cell", () => {
    expect(parabolicVertex(-10, 0, 1)).toBeGreaterThanOrEqual(-0.5);
    expect(parabolicVertex(1, 0, -10)).toBeLessThanOrEqual(0.5);
  });
});

describe("crossCorrelatePhat / GCC-PHAT findOffset", () => {
  it("recovers the offset with a sharp whitened peak", () => {
    const ref = noise(256, 11);
    const clip = shift(ref, 18);
    const r = findOffset(ref, clip, { method: "phat" });
    expect(r.offsetSamples).toBe(18);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
  it("reports low confidence for unrelated signals", () => {
    const r = findOffset(noise(256, 1), noise(256, 424242), { method: "phat" });
    expect(r.confidence).toBeLessThan(0.5);
  });
  it("zeroes silent (sub-eps) frequency bins instead of dividing by zero", () => {
    const c = crossCorrelatePhat(new Float64Array(8), new Float64Array(8));
    expect(c.every((v) => v === 0)).toBe(true);
  });
  it("gives zero confidence when the peak is not positive", () => {
    // constant signals → mean-removed zeros → degenerate; confidence floors at 0
    const r = findOffset(new Float64Array(8), new Float64Array(8), { method: "phat" });
    expect(r.confidence).toBe(0);
  });
});

describe("findOffset interpolation", () => {
  it("returns an integer lag without interpolation", () => {
    const ref = noise(256, 11);
    const clip = shift(ref, 20);
    expect(Number.isInteger(findOffset(ref, clip).offsetSamples)).toBe(true);
  });
  it("refines to a fractional lag near the integer peak", () => {
    const ref = noise(256, 11);
    const clip = shift(ref, 20);
    const r = findOffset(ref, clip, { interpolate: true });
    expect(r.offsetSamples).toBeCloseTo(20, 1);
  });
});

describe("fitDrift", () => {
  it("requires at least two points", () => {
    expect(() => fitDrift([{ atSeconds: 0, offsetSeconds: 0 }])).toThrow(/two points/);
  });
  it("fits a line and reports ppm + midpoint offset", () => {
    // offset grows 0.001s per 100s → slope 1e-5 → 10 ppm
    const d = fitDrift([
      { atSeconds: 0, offsetSeconds: 0 },
      { atSeconds: 100, offsetSeconds: 0.001 },
    ]);
    expect(d.slopePpm).toBeCloseTo(10, 6);
    expect(d.midpointOffsetSeconds).toBeCloseTo(0.0005, 9);
    expect(d.spanSeconds).toBe(100);
  });
  it("finds the time span regardless of point order", () => {
    const d = fitDrift([
      { atSeconds: 100, offsetSeconds: 0.001 },
      { atSeconds: 0, offsetSeconds: 0 },
    ]);
    expect(d.spanSeconds).toBe(100);
    expect(d.slopePpm).toBeCloseTo(10, 6);
  });
  it("handles coincident times without dividing by zero", () => {
    const d = fitDrift([
      { atSeconds: 5, offsetSeconds: 1 },
      { atSeconds: 5, offsetSeconds: 3 },
    ]);
    expect(d.slopePpm).toBe(0);
    expect(d.midpointOffsetSeconds).toBeCloseTo(2, 9);
    expect(d.spanSeconds).toBe(0);
  });
});

describe("driftCorrection", () => {
  it("is identity at zero drift", () => {
    expect(driftCorrection(0)).toEqual({ rate: 1, atempo: 1 });
  });
  it("stretches by 1 + ppm and inverts for atempo", () => {
    const c = driftCorrection(1000); // 1000 ppm = 0.001
    expect(c.rate).toBeCloseTo(1.001, 9);
    expect(c.atempo).toBeCloseTo(1 / 1.001, 9);
  });
});

describe("atempoChain", () => {
  it("returns a single factor when within range", () => {
    expect(atempoChain(1)).toEqual([1]);
    expect(atempoChain(0.999)).toEqual([0.999]);
  });
  it("chains factors above max so they multiply back", () => {
    const chain = atempoChain(4);
    expect(chain).toEqual([2, 2]);
    expect(chain.reduce((a, b) => a * b, 1)).toBeCloseTo(4, 9);
  });
  it("chains factors below min so they multiply back", () => {
    const chain = atempoChain(0.25);
    expect(chain).toEqual([0.5, 0.5]);
    expect(chain.reduce((a, b) => a * b, 1)).toBeCloseTo(0.25, 9);
  });
  it("throws on a non-positive factor", () => {
    expect(() => atempoChain(0)).toThrow(/positive/);
  });
});

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

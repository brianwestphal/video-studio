import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module, no types
import { AUDIO_EVENTS_VERSION, buildAudioEvents, detectOnsets, rmsEnvelope, sectionize, vocalSpans, wordsFromWhisper } from "../tools/audio-events.mjs";

// Build a mono signal: `spans` is [{ amp, seconds }] concatenated at `sampleRate`.
function signal(spans: { amp: number; seconds: number }[], sampleRate: number): Float32Array {
  const total = spans.reduce((n, s) => n + Math.round(s.seconds * sampleRate), 0);
  const x = new Float32Array(total);
  let i = 0;
  for (const s of spans) {
    const n = Math.round(s.seconds * sampleRate);
    for (let j = 0; j < n; j++) x[i++] = s.amp; // DC-ish block → flat RMS = amp
  }
  return x;
}

describe("rmsEnvelope", () => {
  it("requires a positive sampleRate", () => {
    expect(() => rmsEnvelope(new Float32Array(4), {})).toThrow(/sampleRate/);
  });
  it("computes an RMS envelope and peak-normalized dB", () => {
    const sr = 100;
    const x = signal([{ amp: 1, seconds: 0.1 }, { amp: 0.1, seconds: 0.1 }], sr); // 2 hops @ 0.1s
    const env = rmsEnvelope(x, { sampleRate: sr, hopSeconds: 0.1 });
    expect(env.hopSeconds).toBeCloseTo(0.1);
    expect(env.rms.length).toBe(2);
    expect(env.rms[0]).toBeCloseTo(1);
    expect(env.rmsDb[0]).toBeCloseTo(0); // loudest hop → 0 dB
    expect(env.rmsDb[1]).toBeLessThan(-15); // quieter hop
  });
  it("handles an empty signal (no hops)", () => {
    const env = rmsEnvelope(new Float32Array(0), { sampleRate: 100 });
    expect(env.rms).toEqual([]);
    expect(env.rmsDb).toEqual([]);
  });
});

describe("detectOnsets", () => {
  it("fires on a rising flux and respects the refractory gap", () => {
    // hop RMS: low, HIGH (rise → onset), HIGH (no rise), low, HIGH (rise, but within refractory of nothing)
    const env = { hopSeconds: 0.1, rms: [0.0, 1.0, 1.0, 0.0, 1.0] };
    const onsets = detectOnsets(env, { fluxRatio: 0.1, refractorySeconds: 0.05 });
    expect(onsets).toEqual([0.1, 0.4]); // rises at k=1 (0.1s) and k=4 (0.4s); k=2 no rise
  });
  it("suppresses a second onset inside the refractory window", () => {
    const env = { hopSeconds: 0.1, rms: [0, 1, 0, 1] }; // rises at k=1 (0.1) and k=3 (0.3)
    expect(detectOnsets(env, { fluxRatio: 0.1, refractorySeconds: 0.5 })).toEqual([0.1]);
  });
});

describe("vocalSpans", () => {
  it("returns nothing for no words", () => {
    expect(vocalSpans([], 10)).toEqual([]);
  });
  it("drops zero/negative words, sorts, merges within the gap, pads + clamps", () => {
    const words = [
      { start: 5.0, end: 5.4 },
      { start: 0.2, end: 0.6 }, // out of order
      { start: 1.0, end: 1.4 }, // within 1.5s of the 0.2 word → merge
      { start: 9.9, end: 9.9 }, // zero-length → dropped
    ];
    const spans = vocalSpans(words, 6, { gapSeconds: 1.5, padSeconds: 0.3 });
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({ start: 0, end: 1.7, wordCount: 2 }); // 0.2-0.3 clamped to 0; 1.4+0.3
    expect(spans[1]).toEqual({ start: 4.7, end: 5.7, wordCount: 1 });
  });
});

describe("sectionize", () => {
  const sr = 100;
  it("labels vocal / quiet / instrumental and merges runs", () => {
    // 0.0–1.0 loud no words → instrumental; 1.0–2.0 loud with words → vocal; 2.0–3.0 silent → quiet
    const env = rmsEnvelope(
      signal([{ amp: 1, seconds: 1 }, { amp: 1, seconds: 1 }, { amp: 0.0001, seconds: 1 }], sr),
      { sampleRate: sr, hopSeconds: 0.1 },
    );
    const words = [{ start: 1.1, end: 1.9 }];
    const secs = sectionize(env, words, 3, { quietDb: -30, minSpanSeconds: 0.3, gapSeconds: 1.5, padSeconds: 0 });
    expect(secs.map((s) => s.kind)).toEqual(["instrumental", "vocal", "quiet"]);
    expect(secs[0].start).toBe(0);
    expect(secs[2].end).toBe(3); // clamped to total
    expect(secs[1].wordCount).toBe(1);
    expect(typeof secs[0].meanRmsDb).toBe("number");
  });
  it("absorbs a short interior run into the previous and coalesces same-kind", () => {
    // loud(1.0s) / silent(0.2s, too short) / loud(1.0s) → one instrumental section
    const env = rmsEnvelope(
      signal([{ amp: 1, seconds: 1 }, { amp: 0.0001, seconds: 0.2 }, { amp: 1, seconds: 1 }], sr),
      { sampleRate: sr, hopSeconds: 0.1 },
    );
    const secs = sectionize(env, [], 2.2, { minSpanSeconds: 0.8 });
    expect(secs).toHaveLength(1);
    expect(secs[0]).toMatchObject({ kind: "instrumental", start: 0 });
  });
  it("absorbs a short FIRST run into the next", () => {
    // silent(0.2s, too short, first) / loud(2.0s) → one instrumental section from 0
    const env = rmsEnvelope(
      signal([{ amp: 0.0001, seconds: 0.2 }, { amp: 1, seconds: 2 }], sr),
      { sampleRate: sr, hopSeconds: 0.1 },
    );
    const secs = sectionize(env, [], 2.2, { minSpanSeconds: 0.8 });
    expect(secs).toHaveLength(1);
    expect(secs[0]).toMatchObject({ kind: "instrumental", start: 0 });
  });
  it("keeps a single run as-is (no first-run absorption)", () => {
    const env = rmsEnvelope(signal([{ amp: 1, seconds: 2 }], sr), { sampleRate: sr, hopSeconds: 0.1 });
    const secs = sectionize(env, [], 2, { minSpanSeconds: 0.8 });
    expect(secs).toEqual([{ kind: "instrumental", start: 0, end: 2, meanRmsDb: expect.any(Number), wordCount: 0 }]);
  });
});

describe("buildAudioEvents", () => {
  const sr = 100;
  it("requires a positive duration", () => {
    const env = rmsEnvelope(new Float32Array(0), { sampleRate: sr });
    expect(() => buildAudioEvents({ durationSeconds: 0, sampleRate: sr, envelope: env })).toThrow(/durationSeconds/);
  });
  it("assembles a versioned doc with sorted section + onset events", () => {
    // quiet(1.0s) then loud(1.0s): a quiet section, an onset at the 1.0s rise, an
    // instrumental section starting at 1.0s (onset + section share startSeconds → tiebreak).
    const env = rmsEnvelope(
      signal([{ amp: 0.0001, seconds: 1 }, { amp: 1, seconds: 1 }], sr),
      { sampleRate: sr, hopSeconds: 0.1 },
    );
    const doc = buildAudioEvents({
      sourcePath: "/m.wav", durationSeconds: 2, sampleRate: 48000, envelope: env,
      words: [], opts: { minSpanSeconds: 0.5, fluxRatio: 0.1, refractorySeconds: 0.05 },
    });
    expect(doc.version).toBe(AUDIO_EVENTS_VERSION);
    expect(doc.source).toEqual({ path: "/m.wav", durationSeconds: 2, sampleRate: 48000 });
    expect(doc.envelope.rmsDb.length).toBe(env.rmsDb.length);
    // sorted by time; at t=1.0 the instrumental section comes before the onset
    const kinds = doc.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("quiet");
    expect(kinds).toContain("instrumental");
    expect(kinds).toContain("onset");
    const at1 = doc.events.filter((e: { startSeconds: number }) => e.startSeconds === 1);
    expect(at1.map((e: { kind: string }) => e.kind)).toEqual(["instrumental", "onset"]);
  });
  it("adds wordCount only to vocal events", () => {
    const env = rmsEnvelope(signal([{ amp: 1, seconds: 2 }], sr), { sampleRate: sr, hopSeconds: 0.1 });
    const doc = buildAudioEvents({
      sourcePath: "/m.wav", durationSeconds: 2, sampleRate: 48000, envelope: env,
      words: [{ start: 0.1, end: 1.9 }], opts: { minSpanSeconds: 0.5, padSeconds: 0 },
    });
    const vocal = doc.events.find((e: { kind: string }) => e.kind === "vocal");
    expect(vocal.data.wordCount).toBe(1);
    expect(vocal.description).toContain("1 word)"); // singular
    expect(vocal.source).toBeNull();
  });
  it("pluralizes the word count in a multi-word vocal section", () => {
    const env = rmsEnvelope(signal([{ amp: 1, seconds: 2 }], sr), { sampleRate: sr, hopSeconds: 0.1 });
    const doc = buildAudioEvents({
      sourcePath: "/m.wav", durationSeconds: 2, sampleRate: 48000, envelope: env,
      words: [{ start: 0.2, end: 0.6 }, { start: 0.8, end: 1.2 }], opts: { minSpanSeconds: 0.5, padSeconds: 0 },
    });
    const vocal = doc.events.find((e: { kind: string }) => e.kind === "vocal");
    expect(vocal.data.wordCount).toBe(2);
    expect(vocal.description).toContain("2 words)"); // plural
  });
});

describe("wordsFromWhisper", () => {
  it("flattens segments[].words[], applies an offset, and tolerates gaps", () => {
    const doc = {
      segments: [
        { words: [{ word: "a", start: 1, end: 1.2 }, { word: "b", start: 1.2 }] }, // 2nd missing end → dropped
        { text: "no words array" },
        { words: [{ word: "c", start: 2, end: 2.3 }] },
      ],
    };
    expect(wordsFromWhisper(doc, 10)).toEqual([
      { start: 11, end: 11.2 },
      { start: 12, end: 12.3 },
    ]);
  });
  it("returns [] for a missing/empty doc", () => {
    expect(wordsFromWhisper(null)).toEqual([]);
    expect(wordsFromWhisper({})).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  audioContextAt,
  autoCut,
  AUTOCUT_VERSION,
  cutBoundaries,
  evaluate,
  snapToBoundary,
  // @ts-expect-error — JS module, no types
} from "../tools/multicam-autocut.mjs";

// --- fixtures ----------------------------------------------------------------
function group(videoMembers = [{ id: "a" }, { id: "b" }], audioDuration = 10) {
  return {
    id: "g",
    masterAudioId: "aud",
    members: [
      { id: "aud", kind: "audio", offsetSeconds: 0, durationSeconds: audioDuration },
      ...videoMembers.map((m) => ({ kind: "video", offsetSeconds: 0, durationSeconds: 10, ...m })),
    ],
  };
}

// 5 windows (0..10s @2s); pass a per-window scores array per angle.
function saliency(aWins: object[], bWins: object[]) {
  const mk = (wins: object[]) =>
    wins.map((scores, i) => ({ startSeconds: i * 2, endSeconds: i * 2 + 2, scores, saliency: 0.5, confidence: 0.7, source: "vision" }));
  return { version: 1, groupId: "g", windowSeconds: 2, angles: { a: mk(aWins), b: mk(bWins) } };
}

const instrumentalThenVocal = {
  events: [
    { kind: "instrumental", startSeconds: 0, endSeconds: 4 },
    { kind: "vocal", startSeconds: 4, endSeconds: 10 },
    { kind: "onset", startSeconds: 4 },
  ],
};

const allInstrumental = { events: [{ kind: "instrumental", startSeconds: 0, endSeconds: 10 }] };

const aInst = { instrument: 0.9, performer: 0.1, motion: 0, framing: 0.2 };
const bVocal = { instrument: 0.1, performer: 0.9, motion: 0, framing: 0.2 };

describe("audioContextAt", () => {
  it("reports the sectioning kind covering a time, ignoring onsets", () => {
    expect(audioContextAt(instrumentalThenVocal, 1)).toEqual({ isVocal: false, isInstrumental: true, isQuiet: false });
    expect(audioContextAt(instrumentalThenVocal, 5)).toEqual({ isVocal: true, isInstrumental: false, isQuiet: false });
    expect(audioContextAt({ events: [{ kind: "quiet", startSeconds: 0, endSeconds: 4 }] }, 2).isQuiet).toBe(true);
    expect(audioContextAt(null, 1)).toEqual({ isVocal: false, isInstrumental: false, isQuiet: false });
    expect(audioContextAt({ events: [{ kind: "vocal", startSeconds: 0 }] }, 1).isVocal).toBe(false); // no endSeconds
  });
});

describe("cutBoundaries / snapToBoundary", () => {
  it("collects onset times + section bounds, sorted + unique", () => {
    expect(cutBoundaries(instrumentalThenVocal)).toEqual([0, 4, 10]);
    expect(cutBoundaries(null)).toEqual([]);
  });
  it("snaps within tolerance, else leaves the time", () => {
    expect(snapToBoundary(4.2, [0, 4, 10], 0.4)).toBe(4);
    expect(snapToBoundary(5, [0, 4, 10], 0.4)).toBe(5);
  });
});

describe("autoCut — validation", () => {
  it("throws without a group / members / video angles / windows", () => {
    expect(() => autoCut({})).toThrow(/group with members/);
    expect(() => autoCut({ group: { id: "g" } })).toThrow(/group with members/);
    expect(() => autoCut({ group: { id: "g", members: [{ id: "aud", kind: "audio" }] } })).toThrow(/no video angles/);
    expect(() => autoCut({ group: group([{ id: "a", durationSeconds: 0 }], 0) })).toThrow(/no windows/);
  });
});

describe("autoCut — selection", () => {
  it("cuts to the instrument angle on a riff and the singer on vocals", () => {
    const r = autoCut({ group: group(), audioEvents: instrumentalThenVocal, saliency: saliency([aInst, aInst, aInst, aInst, aInst], [bVocal, bVocal, bVocal, bVocal, bVocal]) });
    expect(r.version).toBe(AUTOCUT_VERSION);
    expect(r.switches).toEqual([
      { atSeconds: 0, memberId: "a" },
      { atSeconds: 4, memberId: "b" }, // snapped to the onset at 4
    ]);
    expect(r.rationale[0].why).toMatch(/instrumental → a/);
    expect(r.rationale[1].why).toMatch(/vocals → active singer b/);
  });

  it("honors minShotSeconds (no early switch)", () => {
    const r = autoCut({
      group: group(),
      audioEvents: instrumentalThenVocal,
      saliency: saliency([aInst, aInst, aInst, aInst, aInst], [bVocal, bVocal, bVocal, bVocal, bVocal]),
      params: { minShotSeconds: 6 },
    });
    // b only wins from window 2 (t=4) but the a-shot must last >=6s → cut slips to t=6.
    expect(r.switches).toEqual([
      { atSeconds: 0, memberId: "a" },
      { atSeconds: 6, memberId: "b" },
    ]);
  });

  it("forces variety after maxShotSeconds", () => {
    // a wins everywhere; maxShot=4 (2 windows) forces a cut to b, which then loses back to a.
    const strongA = { instrument: 0.9, performer: 0.9, motion: 0.9, framing: 0.9 };
    const weakB = { instrument: 0.1, performer: 0.1, motion: 0.1, framing: 0.1 };
    const r = autoCut({ group: group(), audioEvents: instrumentalThenVocal, saliency: saliency([strongA, strongA, strongA, strongA, strongA], [weakB, weakB, weakB, weakB, weakB]), params: { maxShotSeconds: 4 } });
    expect(r.switches.map((s: { memberId: string }) => s.memberId)).toEqual(["a", "b", "a"]);
  });

  it("is forced off an angle that runs out of footage", () => {
    // a has saliency entries only for windows 0,1 → unavailable afterward.
    const sal = saliency([aInst, aInst], [bVocal, bVocal, bVocal, bVocal, bVocal]);
    const r = autoCut({ group: group(), audioEvents: instrumentalThenVocal, saliency: sal });
    expect(r.switches).toEqual([
      { atSeconds: 0, memberId: "a" },
      { atSeconds: 4, memberId: "b" },
    ]);
  });

  it("degrades to a footage round-robin with no saliency or audio events", () => {
    const r = autoCut({ group: group(), params: { maxShotSeconds: 4 } });
    expect(r.switches.map((s: { memberId: string }) => s.memberId)).toEqual(["a", "b", "a"]);
    expect(r.switches[1].atSeconds).toBe(4); // no boundaries → unsnapped window start
    expect(r.rationale[0].why).toMatch(/only angle with footage|highest saliency/);
  });

  it("falls back to the first angle for opening windows no angle covers", () => {
    // Both angles' footage starts at 4s, so the first two windows have no available
    // angle → the held angle falls back to the first video angle until footage rolls.
    const g = group([{ id: "a", offsetSeconds: 4 }, { id: "b", offsetSeconds: 4 }]);
    const r = autoCut({ group: g, params: { maxShotSeconds: 4 } });
    expect(r.switches[0]).toEqual({ atSeconds: 0, memberId: "a" });
  });

  it("synthesizes the degraded grid from the longest angle when the master id is unresolved", () => {
    // No saliency and masterAudioId points at no member → fall back to the longest
    // video angle for the grid length (and treat a member with no duration as 0).
    const g = {
      id: "g",
      masterAudioId: "missing",
      members: [
        { id: "a", kind: "video", offsetSeconds: 0, durationSeconds: 6 },
        { id: "b", kind: "video", offsetSeconds: 0 },
      ],
    };
    const r = autoCut({ group: g, params: { maxShotSeconds: 4 } });
    expect(r.switches[0]).toEqual({ atSeconds: 0, memberId: "a" });
    expect(r.switches.at(-1)!.atSeconds).toBeLessThanOrEqual(6);
  });

  it("holds the sole angle when variety cannot be satisfied", () => {
    // One video angle + a small maxShot: the force-variety step has no other angle
    // to switch to, so it holds — a single continuous shot.
    const r = autoCut({ group: group([{ id: "a" }]), params: { maxShotSeconds: 4 } });
    expect(r.switches).toEqual([{ atSeconds: 0, memberId: "a" }]);
  });

  it("allows a long take past maxShot in a sustained instrumental stretch (R-AC8)", () => {
    // a dominates every window during an all-instrumental section. maxShot=4 (2 windows)
    // would normally force a cut, but the long-take exception holds the dominant angle
    // up to the longTake ceiling (8s = 4 windows), then forces variety for the last one.
    const strongA = { instrument: 0.9, performer: 0.9, motion: 0.9, framing: 0.9 };
    const weakB = { instrument: 0.1, performer: 0.1, motion: 0.1, framing: 0.1 };
    const r = autoCut({
      group: group(),
      audioEvents: allInstrumental,
      saliency: saliency([strongA, strongA, strongA, strongA, strongA], [weakB, weakB, weakB, weakB, weakB]),
      params: { maxShotSeconds: 4, longTakeMaxSeconds: 8 },
    });
    expect(r.switches).toEqual([
      { atSeconds: 0, memberId: "a" },
      { atSeconds: 8, memberId: "b" },
    ]);
  });

  it("does not extend a long take when the lead is within longTakeMargin (R-AC8)", () => {
    // Instrumental, but a leads b by only inst·(0.5−0.4)=0.12 < longTakeMargin (0.15) →
    // not a clear solo, so maxShot forces variety at 4s as usual (a, b, back to a).
    const aLead = { instrument: 0.5, performer: 0, motion: 0, framing: 0.2 };
    const bClose = { instrument: 0.4, performer: 0, motion: 0, framing: 0.2 };
    const r = autoCut({
      group: group(),
      audioEvents: allInstrumental,
      saliency: saliency([aLead, aLead, aLead, aLead, aLead], [bClose, bClose, bClose, bClose, bClose]),
      params: { maxShotSeconds: 4, longTakeMaxSeconds: 8 },
    });
    expect(r.switches.map((s: { memberId: string }) => s.memberId)).toEqual(["a", "b", "a"]);
  });

  it("drops a runt trailing shot at the timeline end (VS-61)", () => {
    // 3 windows; the last is a 0.05s sliver. a wins the first two, b the sliver, so the
    // trailing b-shot would be 0.05s — shorter than the model's own min gap (ws/2=1s) —
    // and is merged back into a instead of emitted as a sub-frame span.
    const runt = { instrument: 0.1, performer: 0.1, motion: 0, framing: 0.1 };
    const strong = { instrument: 0.9, performer: 0.9, motion: 0.9, framing: 0.9 };
    const win = (s: number, e: number, scores: object) => ({ startSeconds: s, endSeconds: e, scores, saliency: 0.5, confidence: 0.7, source: "vision" });
    const sal = {
      version: 1,
      groupId: "g",
      windowSeconds: 2,
      angles: {
        a: [win(0, 2, aInst), win(2, 4, aInst), win(4, 4.05, runt)],
        b: [win(0, 2, runt), win(2, 4, runt), win(4, 4.05, strong)],
      },
    };
    const r = autoCut({ group: group([{ id: "a" }, { id: "b" }], 4.05), audioEvents: allInstrumental, saliency: sal });
    expect(r.switches).toEqual([{ atSeconds: 0, memberId: "a" }]);
  });

  it("holds a sole angle through an instrumental long take (no runner-up to cut to)", () => {
    // Instrumental + only one angle: the exception's dominance check has no runner-up
    // (null), so it holds; a single continuous shot, same as without footage to vary to.
    const r = autoCut({
      group: group([{ id: "a" }]),
      audioEvents: allInstrumental,
      saliency: saliency([aInst, aInst, aInst, aInst, aInst], []),
      params: { maxShotSeconds: 4, longTakeMaxSeconds: 8 },
    });
    expect(r.switches).toEqual([{ atSeconds: 0, memberId: "a" }]);
  });
});

describe("autoCut — review signal (VS-63)", () => {
  const salWithConf = (aScores: object, bScores: object, confidence: number) => {
    const mk = (scores: object) => [0, 1, 2, 3, 4].map((i) => ({ startSeconds: i * 2, endSeconds: i * 2 + 2, scores, saliency: 0.5, confidence, source: "vision" }));
    return { version: 1, groupId: "g", windowSeconds: 2, angles: { a: mk(aScores), b: mk(bScores) } };
  };

  const weakB = { instrument: 0.1, performer: 0.1, motion: 0, framing: 0.1 };

  it("flags a near-tie switch (low margin) and names the runner-up", () => {
    const aNear = { instrument: 0.5, performer: 0, motion: 0, framing: 0.2 };
    const bNear = { instrument: 0.48, performer: 0, motion: 0, framing: 0.2 };
    const r = autoCut({ group: group(), audioEvents: allInstrumental, saliency: salWithConf(aNear, bNear, 0.7) });
    expect(r.rationale[0].flagged).toBe(true); // margin ~0.03 < 0.15
    expect(r.rationale[0].runnerUp).toBe("b");
    expect(r.rationale[0].confidence).toBeLessThan(0.15);
  });

  it("flags a low-vision-confidence switch even when the pick is decisive", () => {
    const r = autoCut({ group: group(), audioEvents: allInstrumental, saliency: salWithConf(aInst, weakB, 0.4) });
    expect(r.rationale[0].flagged).toBe(true); // wide margin, but saliency confidence 0.4 < 0.6
    expect(r.rationale[0].confidence).toBeCloseTo(0.4, 3); // min(wide margin, 0.4)
  });

  it("does not flag a decisive, confident switch", () => {
    const r = autoCut({ group: group(), audioEvents: allInstrumental, saliency: salWithConf(aInst, weakB, 0.7) });
    expect(r.rationale[0].flagged).toBe(false); // wide margin + confidence 0.7 > 0.6
    expect(r.rationale[0].runnerUp).toBe("b");
    expect(r.rationale[0].confidence).toBeGreaterThan(0.6);
  });

  it("treats a sole angle with no saliency as fully confident (no runner-up)", () => {
    const r = autoCut({ group: group([{ id: "a" }]) });
    expect(r.rationale[0].runnerUp).toBeNull(); // no contender → margin 1
    expect(r.rationale[0].flagged).toBe(false);
    expect(r.rationale[0].confidence).toBe(1); // no saliency entry → confidence defaults to 1
  });
});

describe("evaluate", () => {
  it("scores instrumental/vocal placement + shot lengths", () => {
    const sal = saliency([aInst, aInst, aInst, aInst, aInst], [bVocal, bVocal, bVocal, bVocal, bVocal]);
    const r = autoCut({ group: group(), audioEvents: instrumentalThenVocal, saliency: sal });
    const m = evaluate({ group: group(), audioEvents: instrumentalThenVocal, saliency: sal, switches: r.switches });
    expect(m).toEqual({
      switches: 2,
      instrumentalOnInstrumentAngle: 1,
      vocalOnSingingAngle: 1,
      shotLengths: [4, 6],
      minShot: 4,
      maxShot: 6,
    });
  });
  it("scores windows where an angle has no saliency entry", () => {
    // a has footage only for windows 0,1; b for all. `top()` must treat a's missing
    // windows as -Infinity rather than crash on the absent entry.
    const sal = saliency([aInst, aInst], [bVocal, bVocal, bVocal, bVocal, bVocal]);
    const r = autoCut({ group: group(), audioEvents: instrumentalThenVocal, saliency: sal });
    const m = evaluate({ group: group(), audioEvents: instrumentalThenVocal, saliency: sal, switches: r.switches });
    expect(m.vocalOnSingingAngle).toBe(1);
  });

  it("returns null ratios when there are no instrumental/vocal windows", () => {
    const sal = saliency([aInst, aInst, aInst, aInst, aInst], [bVocal, bVocal, bVocal, bVocal, bVocal]);
    const quiet = { events: [{ kind: "quiet", startSeconds: 0, endSeconds: 10 }] };
    const r = autoCut({ group: group(), audioEvents: quiet, saliency: sal });
    const m = evaluate({ group: group(), audioEvents: quiet, saliency: sal, switches: r.switches });
    expect(m.instrumentalOnInstrumentAngle).toBeNull();
    expect(m.vocalOnSingingAngle).toBeNull();
  });
});

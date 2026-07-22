import { describe, expect, it } from "vitest";
import { AUDIO_CUT_FADE_SECONDS, audioCutFadeFilter } from "../tools/audio-cuts.mjs";

describe("audioCutFadeFilter", () => {
  it("fades both boundaries of an ordinary hard-cut clip", () => {
    expect(AUDIO_CUT_FADE_SECONDS).toBe(0.005);
    expect(audioCutFadeFilter(2)).toBe(
      "afade=t=in:st=0:d=0.005,afade=t=out:st=1.995:d=0.005",
    );
  });

  it("bounds fades to half of very short clips", () => {
    expect(audioCutFadeFilter(0.004)).toBe(
      "afade=t=in:st=0:d=0.002,afade=t=out:st=0.002:d=0.002",
    );
  });

  it("supports an offset and transition-protected boundaries", () => {
    expect(audioCutFadeFilter(2, { offsetSeconds: 0.25, fadeIn: false })).toBe(
      "afade=t=out:st=2.245:d=0.005",
    );
    expect(audioCutFadeFilter(2, { fadeIn: false, fadeOut: false })).toBe("");
  });

  it("rejects non-positive durations", () => {
    expect(() => audioCutFadeFilter(0)).toThrow(/positive/);
    expect(() => audioCutFadeFilter(Number.NaN)).toThrow(/positive/);
  });
});

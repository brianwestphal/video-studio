import { describe, expect, it } from "vitest";

import { buildManifest } from "../tools/export-manifest.mjs";
import { buildFcpxml, frameDuration, rationalTime } from "../tools/fcpxml.mjs";

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

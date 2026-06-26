import { describe, expect, it } from "vitest";

import { assignSourceIds, buildSourcesManifest, isVideoFile, sourceSlug, VIDEO_EXTENSIONS } from "../tools/sources.mjs";

describe("isVideoFile", () => {
  it("accepts known video extensions, case-insensitively", () => {
    expect(isVideoFile("clip.mp4")).toBe(true);
    expect(isVideoFile("CLIP.MOV")).toBe(true);
    expect(isVideoFile("a.mkv")).toBe(true);
    expect([...VIDEO_EXTENSIONS]).toContain(".webm");
  });
  it("rejects non-video and extensionless names", () => {
    expect(isVideoFile("notes.txt")).toBe(false);
    expect(isVideoFile("README")).toBe(false);
    expect(isVideoFile("cap.svg")).toBe(false);
  });
});

describe("sourceSlug", () => {
  it("kebab-cases the basename without extension", () => {
    expect(sourceSlug("/a/b/Interview Take 2.mov")).toBe("interview-take-2");
    expect(sourceSlug("clip.MP4")).toBe("clip");
  });
  it("falls back to 'source' when nothing usable remains", () => {
    expect(sourceSlug("/path/.mov")).toBe("source");
    expect(sourceSlug("/path/___.mp4")).toBe("source");
  });
});

describe("assignSourceIds", () => {
  it("keeps distinct slugs as-is", () => {
    expect(assignSourceIds(["/x/a.mov", "/x/b.mov"])).toEqual([
      { path: "/x/a.mov", id: "a" },
      { path: "/x/b.mov", id: "b" },
    ]);
  });
  it("disambiguates colliding slugs with a numeric suffix", () => {
    const out = assignSourceIds(["/x/clip.mov", "/y/clip.mov"]);
    expect(out.map((s) => s.id)).toEqual(["clip", "clip-2"]);
  });
  it("stays unique even when a later slug collides with an earlier disambiguation", () => {
    const ids = assignSourceIds(["/a/clip.mov", "/b/clip.mov", "/c/clip-2.mov"]).map((s) => s.id);
    expect(new Set(ids).size).toBe(3); // all unique
    expect(ids[0]).toBe("clip");
    expect(ids[1]).toBe("clip-2");
    expect(ids[2]).toBe("clip-2-2");
  });
});

describe("buildSourcesManifest", () => {
  it("lists every source and tags the union of scenes with sourceId", () => {
    const m = buildSourcesManifest([
      { id: "a", path: "/a.mov", fps: 24, durationSeconds: 10, width: 1920, height: 1080, scenes: [{ start: "00:00:00:00", startSeconds: 0 }, { start: "00:00:05:00", startSeconds: 5 }] },
      { id: "b", path: "/b.mov", fps: 30, durationSeconds: 4, width: 1280, height: 720, scenes: [{ start: "00:00:00:00", startSeconds: 0 }] },
    ]);
    expect(m.sources).toEqual([
      { id: "a", path: "/a.mov", fps: 24, durationSeconds: 10, width: 1920, height: 1080, sceneCount: 2 },
      { id: "b", path: "/b.mov", fps: 30, durationSeconds: 4, width: 1280, height: 720, sceneCount: 1 },
    ]);
    expect(m.scenes).toHaveLength(3);
    expect(m.scenes[0]).toMatchObject({ sourceId: "a", start: "00:00:00:00" });
    expect(m.scenes[2]).toMatchObject({ sourceId: "b", start: "00:00:00:00" });
  });
  it("tolerates a source with no scenes", () => {
    const m = buildSourcesManifest([{ id: "a", path: "/a.mov", fps: 24, durationSeconds: 1, width: 1, height: 1 }]);
    expect(m.sources[0].sceneCount).toBe(0);
    expect(m.scenes).toEqual([]);
  });
});

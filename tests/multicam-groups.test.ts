import { describe, expect, it } from "vitest";

import {
  eventKey,
  groupByFilename,
  groupByFolder,
  groupByTimeWindow,
  proposeGroups,
  slug,
} from "../tools/multicam-groups.mjs";

describe("slug", () => {
  it("kebab-cases and trims", () => {
    expect(slug("Ceremony Cam")).toBe("ceremony-cam");
    expect(slug("--A/B--")).toBe("a-b");
  });
  it("falls back to 'group' when empty", () => {
    expect(slug("___")).toBe("group");
  });
});

describe("groupByFolder", () => {
  it("groups by containing directory, dropping singletons", () => {
    const g = groupByFolder([
      { id: "a", path: "/shoot/ceremony/a.mov" },
      { id: "b", path: "/shoot/ceremony/b.mov" },
      { id: "c", path: "/shoot/reception/c.mov" },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ id: "ceremony", reason: "same folder", memberIds: ["a", "b"] });
  });
  it("handles a path with no directory", () => {
    const g = groupByFolder([
      { id: "a", path: "a.mov" },
      { id: "b", path: "b.mov" },
    ]);
    expect(g[0].memberIds).toEqual(["a", "b"]);
    expect(g[0].id).toBe("folder");
  });
});

describe("groupByTimeWindow", () => {
  it("clusters overlapping recording windows", () => {
    const g = groupByTimeWindow([
      { id: "a", startMs: 0, durationSeconds: 100 },
      { id: "b", startMs: 50_000, durationSeconds: 100 }, // overlaps a
      { id: "c", startMs: 10_000_000, durationSeconds: 100 }, // far away
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ id: "event-1", reason: "overlapping recording windows", memberIds: ["a", "b"] });
  });
  it("joins windows within the gap even if not overlapping", () => {
    const g = groupByTimeWindow(
      [
        { id: "a", startMs: 0, durationSeconds: 10 },
        { id: "b", startMs: 40_000, durationSeconds: 10 }, // 30s after a ends
      ],
      { gapSeconds: 60 },
    );
    expect(g[0].memberIds).toEqual(["a", "b"]);
  });
  it("keeps distant windows separate (no group)", () => {
    const g = groupByTimeWindow(
      [
        { id: "a", startMs: 0, durationSeconds: 10 },
        { id: "b", startMs: 40_000, durationSeconds: 10 },
      ],
      { gapSeconds: 1 },
    );
    expect(g).toEqual([]);
  });
  it("ignores sources without a finite startMs", () => {
    const g = groupByTimeWindow([
      { id: "a", startMs: 0, durationSeconds: 10 },
      { id: "b" },
    ]);
    expect(g).toEqual([]);
  });
  it("treats a missing duration as a zero-length window", () => {
    const g = groupByTimeWindow(
      [
        { id: "a", startMs: 0 }, // no durationSeconds → window [0, 0]
        { id: "b", startMs: 5000, durationSeconds: 10 },
      ],
      { gapSeconds: 60 },
    );
    expect(g[0].memberIds).toEqual(["a", "b"]);
  });
  it("numbers multiple clusters", () => {
    const g = groupByTimeWindow([
      { id: "a", startMs: 0, durationSeconds: 10 },
      { id: "b", startMs: 1000, durationSeconds: 10 },
      { id: "c", startMs: 10_000_000, durationSeconds: 10 },
      { id: "d", startMs: 10_001_000, durationSeconds: 10 },
    ]);
    expect(g.map((x) => x.id)).toEqual(["event-1", "event-2"]);
  });
});

describe("eventKey", () => {
  it("strips trailing camera / angle / take tokens", () => {
    expect(eventKey("/x/ceremony-cam1.mov")).toBe("ceremony");
    expect(eventKey("ceremony_camera2.mp4")).toBe("ceremony");
    expect(eventKey("ceremony-angle3.mov")).toBe("ceremony");
    expect(eventKey("interview-take-2.mov")).toBe("interview");
  });
  it("strips a trailing single-letter angle and sequence digits", () => {
    expect(eventKey("ceremony-a.mov")).toBe("ceremony");
    expect(eventKey("wedding_001.mov")).toBe("wedding");
  });
  it("leaves a plain name untouched and is case-insensitive", () => {
    expect(eventKey("/d/Reception.MOV")).toBe("reception");
  });
  it("falls back to the basename when stripping empties it", () => {
    expect(eventKey("/d/cam1.mov")).toBe("cam1");
  });
});

describe("groupByFilename", () => {
  it("groups by shared event key, dropping singletons", () => {
    const g = groupByFilename([
      { id: "a", path: "/d/ceremony-cam1.mov" },
      { id: "b", path: "/d/ceremony-cam2.mov" },
      { id: "c", path: "/d/reception.mov" },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ id: "ceremony", reason: "shared filename pattern", memberIds: ["a", "b"] });
  });
});

describe("proposeGroups", () => {
  const sources = [
    { id: "a", path: "/shoot/a.mov", durationSeconds: 100, startMs: 0 },
    { id: "b", path: "/shoot/b.mov", durationSeconds: 100, startMs: 30_000 },
  ];
  it("dispatches to an explicit strategy", () => {
    expect(proposeGroups(sources, { strategy: "folder" })[0].reason).toBe("same folder");
    expect(proposeGroups(sources, { strategy: "time" })[0].reason).toBe("overlapping recording windows");
    expect(proposeGroups(sources, { strategy: "filename" })).toEqual([]); // distinct keys a/b
  });
  it("auto prefers time when any source is timestamped", () => {
    expect(proposeGroups(sources)[0].reason).toBe("overlapping recording windows");
  });
  it("auto falls back to folder when no timestamps", () => {
    const noTime = sources.map((s) => ({ id: s.id, path: s.path }));
    expect(proposeGroups(noTime)[0].reason).toBe("same folder");
  });
  it("auto falls back to filename when folders are all distinct", () => {
    const g = proposeGroups([
      { id: "a", path: "/p/ceremony-cam1.mov" },
      { id: "b", path: "/q/ceremony-cam2.mov" },
    ]);
    expect(g[0].reason).toBe("shared filename pattern");
  });
  it("returns no groups when nothing clusters", () => {
    expect(proposeGroups([{ id: "a", path: "/p/x.mov" }, { id: "b", path: "/q/y.mov" }])).toEqual([]);
  });
});

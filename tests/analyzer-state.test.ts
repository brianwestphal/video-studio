import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadState, type PersistedState, saveState, stateFilePath, stateMatchesVideo, STATE_VERSION } from "../src/analyzer-state.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vs-state-"));
}

function sampleState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: STATE_VERSION,
    videoPath: "/abs/video.mov",
    videoSize: 123,
    videoMtimeMs: 456,
    duration: 10,
    fps: 24,
    scenes: [{ startFrame: 0, endFrame: 240 }],
    descriptions: { 0: "a scene" },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("stateFilePath", () => {
  it("points at state.json inside the data dir", () => {
    expect(stateFilePath("/data")).toBe(join("/data", "state.json"));
  });
});

describe("saveState + loadState round-trip", () => {
  it("writes then reads back an identical state", () => {
    const dir = tmp();
    const state = sampleState();
    saveState(dir, state);
    expect(loadState(dir)).toEqual(state);
  });

  it("returns null when no state file exists", () => {
    expect(loadState(tmp())).toBeNull();
  });

  it("returns null (ignores) a state written by an older STATE_VERSION", () => {
    const dir = tmp();
    saveState(dir, sampleState({ version: STATE_VERSION - 1 }));
    expect(loadState(dir)).toBeNull();
  });

  it("returns null and warns on a corrupt state file", () => {
    const dir = tmp();
    writeFileSync(stateFilePath(dir), "{ not valid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadState(dir)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("stateMatchesVideo", () => {
  it("matches when resolved path, size, and mtime all agree", () => {
    const dir = tmp();
    const file = join(dir, "clip.mov");
    writeFileSync(file, "x");
    const stat = statSync(file);
    const state = sampleState({ videoPath: resolve(file), videoSize: stat.size, videoMtimeMs: stat.mtimeMs });
    expect(stateMatchesVideo(state, file, stat)).toBe(true);
  });

  it("rejects a different file size", () => {
    const dir = tmp();
    const file = join(dir, "clip.mov");
    writeFileSync(file, "x");
    const stat = statSync(file);
    const state = sampleState({ videoPath: resolve(file), videoSize: stat.size + 1, videoMtimeMs: stat.mtimeMs });
    expect(stateMatchesVideo(state, file, stat)).toBe(false);
  });

  it("rejects a different mtime", () => {
    const dir = tmp();
    const file = join(dir, "clip.mov");
    writeFileSync(file, "x");
    const stat = statSync(file);
    const state = sampleState({ videoPath: resolve(file), videoSize: stat.size, videoMtimeMs: stat.mtimeMs + 1 });
    expect(stateMatchesVideo(state, file, stat)).toBe(false);
  });

  it("rejects a different path", () => {
    const dir = tmp();
    const file = join(dir, "clip.mov");
    writeFileSync(file, "x");
    const stat = statSync(file);
    const state = sampleState({ videoPath: "/somewhere/else.mov", videoSize: stat.size, videoMtimeMs: stat.mtimeMs });
    expect(stateMatchesVideo(state, file, stat)).toBe(false);
  });
});

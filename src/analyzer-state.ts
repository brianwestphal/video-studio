// Resumable-run state persistence. A run records what it has already computed
// (scene boundaries + per-scene descriptions) keyed to the exact video file, so
// a re-run resumes instead of redoing the expensive full-decode pass. All I/O is
// against a caller-supplied data dir, so this is unit-testable with a temp dir.
import * as fs from "fs";
import * as path from "path";

import type { Scene } from "./scene-math.js";

// Bump when the meaning of persisted scenes changes so stale caches are ignored:
//   2 — scenes became frame-based
//   3 — frame count derived from the video stream, not the container (VS-15);
//       v2 caches can hold a phantom final scene past the last real frame.
export const STATE_VERSION = 3;

// Everything we persist between runs so a re-run can resume instead of redoing work.
export interface PersistedState {
  version: number;
  videoPath: string;
  videoSize: number;
  videoMtimeMs: number;
  duration: number; // seconds
  fps: number;
  scenes: Scene[]; // detected boundaries in frames (the expensive full-decode result)
  descriptions: Record<number, string>; // sceneIndex -> description (incremental progress)
}

export function stateFilePath(dataDir: string): string {
  return path.join(dataDir, "state.json");
}

export function loadState(dataDir: string): PersistedState | null {
  const file = stateFilePath(dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedState;
    if (parsed.version !== STATE_VERSION) return null;
    return parsed;
  } catch {
    console.warn(`Warning: could not read existing state at ${file}; starting fresh.`);
    return null;
  }
}

// Atomic write so an interruption mid-save can't corrupt the state file.
export function saveState(dataDir: string, state: PersistedState): void {
  const file = stateFilePath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// A saved state is only reusable if it belongs to the same video file content.
export function stateMatchesVideo(state: PersistedState, videoPath: string, stat: fs.Stats): boolean {
  return state.videoPath === path.resolve(videoPath) && state.videoSize === stat.size && state.videoMtimeMs === stat.mtimeMs;
}

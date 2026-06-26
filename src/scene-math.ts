// Pure, side-effect-free scene/time math used by the analyzer.
//
// Kept separate from analyzer.ts (which does ffmpeg/ollama/fs I/O and runs on
// import) so this logic can be unit-tested in isolation. Everything here is a
// pure function of its inputs.

// Collapse scene boundaries closer together than this to avoid flicker /
// fast-cut over-segmentation. Frame-rate-aware (multiplied by fps at use).
export const MIN_SCENE_SEC = 1.0;

// Scene boundaries are stored as exact frame indices for frame-level accuracy.
// The range is [startFrame, endFrame) — endFrame is the first frame of the next scene.
export interface Scene {
  startFrame: number;
  endFrame: number;
}

// Parse an ffprobe frame-rate string like "24/1" or "30000/1001" into fps.
// Returns NaN for anything it can't parse so callers can fall back.
export function parseFps(rate: string | undefined): number {
  if (!rate) return NaN;
  const m = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(rate.trim());
  if (!m) return NaN;
  const num = parseFloat(m[1]!);
  const den = m[2] ? parseFloat(m[2]) : 1;
  return den ? num / den : NaN;
}

// Convert detected cut times (seconds) into frame-accurate [startFrame, endFrame)
// scene ranges, snapping each cut to the nearest frame and merging boundaries
// closer together than `minSceneSec`.
export function buildScenes(cutTimes: number[], totalFrames: number, fps: number, minSceneSec: number = MIN_SCENE_SEC): Scene[] {
  const minGap = Math.max(1, Math.round(minSceneSec * fps));
  const cutFrames = cutTimes.map((t) => Math.round(t * fps));
  const starts = [0, ...cutFrames].filter((f) => f < totalFrames).sort((a, b) => a - b);

  const merged: number[] = [];
  for (const f of starts) {
    const prev = merged[merged.length - 1];
    if (prev === undefined || f - prev >= minGap) {
      merged.push(f);
    }
  }

  return merged.map((startFrame, i) => ({
    startFrame,
    endFrame: i + 1 < merged.length ? merged[i + 1]! : totalFrames,
  }));
}

const pad = (n: number) => n.toString().padStart(2, "0");

// Frame index → SMPTE-style HH:MM:SS:FF timecode (non-drop; assumes integer/CFR fps).
export function formatTimecode(frame: number, fps: number): string {
  const fpsInt = Math.round(fps);
  const totalSeconds = Math.floor(frame / fpsInt);
  const ff = frame % fpsInt;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(ff)}`;
}

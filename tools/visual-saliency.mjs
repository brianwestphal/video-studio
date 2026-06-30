// Pure logic for per-angle visual saliency (docs/visual-saliency.md, R-VS; VS-45).
// "Which angle is worth showing?" — scores each synced multicam video angle over
// aligned windows on the group clock: performer activity, instrument-in-use,
// motion/energy, framing, subject presence. The cheap motion pass + the (gated)
// Ollama vision calls live in the I/O layer (tools/analyze-visual-saliency.mjs);
// everything here — windowing, group-clock mapping, motion normalization, vision-
// reply parsing, score combination, gating, schema assembly — is side-effect-free
// and held to 100% coverage (vitest.config.ts).

export const SALIENCY_VERSION = 1;
export const DEFAULT_WINDOW_SECONDS = 2.0;
// A raw frame-difference magnitude (the average luma of a downscaled
// difference frame, ~0..255) at/above this maps to motion 1.0. Tunable via the
// CLI; ~8 reads "clearly moving" at the I/O layer's 64x36 / 2fps sampling.
export const DEFAULT_MOTION_SCALE = 8;
// Independent 0..1 dimensions scored per window.
export const SCORE_KEYS = ["performer", "instrument", "motion", "framing", "presence"];
// Weights for the combined `saliency` convenience score (advisory; the selector,
// VS-46, owns the final weighting — R-VS5). Sum need not be 1; it is normalized.
export const DEFAULT_WEIGHTS = { performer: 0.35, instrument: 0.2, motion: 0.15, framing: 0.15, presence: 0.15 };

const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function toNumber(v, dflt = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Pull the first balanced {...} JSON object out of a model reply (tolerates code
// fences / prose around it). Returns the parsed object, or null if none/invalid.
function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// Aligned window grid on the group clock, [0, totalSeconds). The last window is
// truncated to totalSeconds. Same grid for every angle so the selector compares
// like-for-like (R-VS1).
export function buildWindows(totalSeconds, windowSeconds = DEFAULT_WINDOW_SECONDS) {
  if (!(totalSeconds > 0)) throw new Error("visual-saliency: totalSeconds must be > 0");
  if (!(windowSeconds > 0)) throw new Error("visual-saliency: windowSeconds must be > 0");
  const windows = [];
  for (let s = 0; s < totalSeconds - 1e-9; s += windowSeconds) {
    windows.push({ startSeconds: round3(s), endSeconds: round3(Math.min(s + windowSeconds, totalSeconds)) });
  }
  return windows;
}

// Group-clock time → the angle's own media time (mirrors resolveAngleCuts in
// multicam.mjs: member_local = (group − correctedOffset)/rate).
export function sourceTime(groupSeconds, member) {
  const rate = member.rateCorrection ?? 1;
  const offset = member.correctedOffsetSeconds ?? member.offsetSeconds ?? 0;
  return (groupSeconds - offset) / rate;
}

// Does this angle have footage at the window's center? (Angles roll at different
// times; a window before/after an angle's media has no frame to score.)
export function angleCoversWindow(window, member) {
  const center = (window.startSeconds + window.endSeconds) / 2;
  const t = sourceTime(center, member);
  return t >= 0 && t <= (member.durationSeconds ?? Infinity);
}

// Normalize a raw frame-difference magnitude to a 0..1 motion score (saturating).
export function normalizeMotion(value, scale = DEFAULT_MOTION_SCALE) {
  if (!(scale > 0) || !(value > 0)) return 0;
  return round3(clamp01(value / scale));
}

// Parse a vision model's reply into { scores, labels, confidence }. Accepts either
// flat keys (`{"performer":0.9,…}`) or a nested `{"scores":{…}}`; missing/invalid
// numbers default to 0 (confidence 0.5); labels must be strings.
export function parseVisionReply(text) {
  const obj = extractJson(text) ?? {};
  const src = obj.scores && typeof obj.scores === "object" ? obj.scores : obj;
  const scores = {};
  for (const k of SCORE_KEYS) scores[k] = round3(clamp01(toNumber(src[k])));
  const labels = Array.isArray(obj.labels) ? obj.labels.filter((x) => typeof x === "string") : [];
  const confidence = round3(clamp01(toNumber(obj.confidence, 0.5)));
  return { scores, labels, confidence };
}

// Weighted, normalized combination of the per-dimension scores → one 0..1 saliency.
export function combineSaliency(scores, weights = DEFAULT_WEIGHTS) {
  let sum = 0;
  let wsum = 0;
  for (const k of SCORE_KEYS) {
    const w = weights[k] ?? 0;
    sum += w * clamp01(toNumber(scores?.[k]));
    wsum += w;
  }
  return wsum > 0 ? round3(clamp01(sum / wsum)) : 0;
}

// Decide which window indices get a (costly) vision call (R-VS2). `mode`:
//   "motion" — none (motion-only, cheapest);
//   "grid"   — all windows (then capped);
//   "vision" — windows near an audio/section boundary OR with high motion (default).
// When more candidates than `cap`, keep the highest-motion ones. Returns the
// chosen indices in ascending order; the I/O logs how many were skipped.
export function selectVisionWindows(
  windows,
  { mode = "vision", motion = [], boundaries = [], cap = Infinity, motionThreshold = 0.3, boundaryToleranceSeconds = 1.0 } = {},
) {
  if (mode === "motion") return [];
  let candidates;
  if (mode === "grid") {
    candidates = windows.map((_, i) => i);
  } else {
    candidates = [];
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const nearBoundary = boundaries.some((b) => b >= w.startSeconds - boundaryToleranceSeconds && b <= w.endSeconds + boundaryToleranceSeconds);
      const energetic = (motion[i] ?? 0) >= motionThreshold;
      if (nearBoundary || energetic) candidates.push(i);
    }
  }
  if (candidates.length <= cap) return candidates.sort((a, b) => a - b);
  return [...candidates].sort((a, b) => (motion[b] ?? 0) - (motion[a] ?? 0)).slice(0, cap).sort((a, b) => a - b);
}

// Section boundary times (group clock) from an audio-events doc — the start/end of
// every non-onset (sectioning) event. Used to gate vision toward where the music
// changes (R-VS2). Returns a sorted, de-duplicated list.
export function sectionBoundaries(audioEvents) {
  const out = new Set();
  for (const e of audioEvents?.events ?? []) {
    if (e.kind && e.kind !== "onset") {
      if (Number.isFinite(e.startSeconds)) out.add(round3(e.startSeconds));
      if (Number.isFinite(e.endSeconds)) out.add(round3(e.endSeconds));
    }
  }
  return [...out].sort((a, b) => a - b);
}

// One window's score entry for the schema. `scores` carries whatever was measured
// (motion always; the rest from vision when run); `source` records which.
export function assembleWindowScore({ window, scores = {}, labels = [], confidence = 0.5, source = "motion", weights = DEFAULT_WEIGHTS }) {
  const norm = {};
  for (const k of SCORE_KEYS) norm[k] = round3(clamp01(toNumber(scores[k])));
  return {
    startSeconds: window.startSeconds,
    endSeconds: window.endSeconds,
    scores: norm,
    labels: labels.filter((x) => typeof x === "string"),
    saliency: combineSaliency(norm, weights),
    confidence: round3(clamp01(toNumber(confidence, 0.5))),
    source,
  };
}

// The versioned per-group saliency document (R-VS1). `angles` is angleId → window
// score entries (already aligned to the same window grid).
export function buildSaliency({ groupId, windowSeconds = DEFAULT_WINDOW_SECONDS, angles = {} }) {
  return { version: SALIENCY_VERSION, groupId, windowSeconds, angles };
}

// The structured prompt the vision model answers per sampled frame. Kept here (pure)
// so its wording is reviewable; the I/O layer sends it with the frame.
export function visionPrompt() {
  return [
    "You are scoring one frame from one camera angle of a live music multi-cam shoot.",
    "Reply with ONLY a compact JSON object, no prose, with these keys (numbers 0.0–1.0):",
    '  "performer": is a person actively performing (singing/talking/playing) vs idle,',
    '  "instrument": is a musical instrument visible AND being played,',
    '  "motion": visible motion/energy in the frame,',
    '  "framing": shot quality — well-framed close/medium subject (1.0) vs empty/wide/cutaway (0.0),',
    '  "presence": a person/face is present and prominent,',
    '  "confidence": your confidence 0.0–1.0,',
    '  "labels": a short array of free-text tags (e.g. ["singing","close-up"]).',
    'Example: {"performer":0.9,"instrument":0.2,"motion":0.4,"framing":0.8,"presence":1.0,"confidence":0.7,"labels":["singing","medium-shot"]}',
  ].join("\n");
}

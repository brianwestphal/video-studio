// Pure model for the multi-cam review UI (docs/multicam-review-ui.md, R-RUI; VS-65).
// Turns an autoCut result (switches + the R-AC9 review signal) into the segments the
// UI surfaces, lists the candidate angles per segment, and applies the user's picks
// back onto the switch list with a change history. Deterministic; no I/O — the HTTP
// server, browser page, and ffmpeg preview extraction live in review-switches.mjs.
import { angleCoversWindow } from "./visual-saliency.mjs";

export const REVIEW_VERSION = 1;

const round3 = (n) => Math.round(n * 1000) / 1000;

// One reviewable segment per switch: its [atSeconds, endSeconds) span on the group
// clock plus a ±contextSeconds preview window (clamped to [0, timelineEnd]). With
// includeAll=false (default) only switches the selector `flagged` are returned; the
// UI's `--all` passes includeAll=true to review every cut. `index` points back into
// the switch list for write-back.
export function reviewSegments({ switches, rationale = [], timelineEnd, contextSeconds = 2, includeAll = false }) {
  if (!Array.isArray(switches)) return [];
  const out = [];
  for (let i = 0; i < switches.length; i++) {
    const r = rationale[i] || {};
    if (!includeAll && !r.flagged) continue;
    const atSeconds = switches[i].atSeconds;
    const endSeconds = i + 1 < switches.length ? switches[i + 1].atSeconds : timelineEnd;
    out.push({
      index: i,
      atSeconds,
      endSeconds,
      chosen: switches[i].memberId,
      runnerUp: r.runnerUp ?? null,
      confidence: r.confidence ?? null,
      why: r.why ?? null,
      flagged: !!r.flagged,
      previewStart: Math.max(0, round3(atSeconds - contextSeconds)),
      previewEnd: Math.min(timelineEnd, round3(endSeconds + contextSeconds)),
    });
  }
  return out;
}

// The angle ids the user can choose between for a segment: every video angle whose
// footage covers the segment, the auto-chosen angle first, then the rest in input
// order (deduped). The chosen angle is always included even if the coverage check is
// borderline (it is by construction a real switch target).
export function candidateAngles(group, segment) {
  const videos = (group?.members || []).filter((m) => m.kind === "video");
  const win = { startSeconds: segment.atSeconds, endSeconds: segment.endSeconds };
  const covering = videos.filter((m) => angleCoversWindow(win, m)).map((m) => m.id);
  return [...new Set([segment.chosen, ...covering.filter((id) => id !== segment.chosen)])];
}

// Apply the user's per-segment picks onto the switch list and append a change history.
// `choices`: [{ index, memberId, note? }]. Only picks that actually change the angle
// (to !== from) are applied and logged. `timestamp` is supplied by the I/O caller (kept
// out of here so the model stays deterministic). Returns fresh arrays (no mutation).
export function applyReview({ switches, history = [], choices = [], timestamp = null }) {
  const next = switches.map((s) => ({ ...s }));
  const added = [];
  for (const c of choices) {
    if (c == null || c.index == null || c.index < 0 || c.index >= next.length) continue;
    const from = next[c.index].memberId;
    if (!c.memberId || c.memberId === from) continue;
    added.push({ atSeconds: next[c.index].atSeconds, from, to: c.memberId, at: timestamp, note: c.note ?? null });
    next[c.index].memberId = c.memberId;
  }
  return { switches: next, history: [...history, ...added] };
}

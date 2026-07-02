// Pure auto multi-cam angle selection (docs/multicam-auto-cut.md, R-AC; VS-46).
// Correlates the synced group (multicam.json) + audio-events.json (VS-44) +
// per-angle visual saliency (VS-45) into a `switches` list that drops straight into
// the existing consumers (buildMulticamFcpxml / expandMulticamGroup), plus a
// parallel `rationale`. Strategy: weighted per-window scoring (the rule priors —
// riff→instrument angle, vocal→active-singer angle — live inside the weights) +
// constraint smoothing (min/max shot length, cut-on-onset snapping). Deterministic;
// no I/O — the file reading + writing is in multicam-autocut-cli.mjs. 100% covered.
import { angleCoversWindow } from "./visual-saliency.mjs";

export const AUTOCUT_VERSION = 1;

export const DEFAULT_PARAMS = {
  minShotSeconds: 0.5, // nominal floor; effective granularity is the saliency window (~1–2s)
  maxShotSeconds: 8, // force variety after this, unless a long-take exception applies
  longTakeMaxSeconds: 16, // a dominant angle may hold this long past maxShot in a sustained instrumental stretch (R-AC8)
  longTakeMargin: 0.15, // …but only while it beats the runner-up by at least this (a clear solo, not a near-tie)
  snapToleranceSeconds: 0.4,
  switchMargin: 0.05, // a challenger must beat the held angle by this to cut early
  windowSeconds: 2.0, // only used in the degraded (no-saliency) fallback grid
  startSeconds: 0,
  weights: { perf: 1.0, inst: 1.2, vocal: 1.0, motion: 0.4, framing: 0.5 },
  // Review flagging (VS-63): a switch is flagged for human review when the pick was a
  // near-tie (normalized score margin over the runner-up < reviewMarginThreshold) OR the
  // vision model was unsure (saliency confidence < reviewConfidenceThreshold). Generous
  // by design — better to over-ask than miss a bad auto-pick.
  reviewMarginThreshold: 0.15,
  reviewConfidenceThreshold: 0.6,
};

const round3 = (n) => Math.round(n * 1000) / 1000;

// Per-switch review signal: how close the call was (`margin`, 0..1 normalized gap over
// the runner-up; 1 = no contender) and how sure the vision model was (`salConf`). The
// combined `confidence` is the weaker of the two, and `flagged` trips when either falls
// below its threshold. All the UI (VS-63) needs to decide which cuts to surface.
function switchConfidence(scoreChosen, scoreRunnerUp, salConf, p) {
  // `bestAt` returns null (not a -Infinity angle) when there is no valid contender.
  const margin = scoreRunnerUp == null
    ? 1
    : Math.max(0, Math.min(1, (scoreChosen - scoreRunnerUp) / (Math.abs(scoreChosen) + 1e-6)));
  const flagged = margin < p.reviewMarginThreshold || salConf < p.reviewConfidenceThreshold;
  return { margin: round3(margin), salConf: round3(salConf), confidence: round3(Math.min(margin, salConf)), flagged };
}

// Audio context covering a group-clock time: which sectioning kinds (vocal /
// instrumental / quiet) contain it. Drives the riff/vocal priors.
export function audioContextAt(audioEvents, seconds) {
  const ctx = { isVocal: false, isInstrumental: false, isQuiet: false };
  for (const e of audioEvents?.events ?? []) {
    if (e.kind === "onset" || !Number.isFinite(e.startSeconds) || !Number.isFinite(e.endSeconds)) continue;
    if (seconds >= e.startSeconds && seconds < e.endSeconds) {
      if (e.kind === "vocal") ctx.isVocal = true;
      else if (e.kind === "instrumental") ctx.isInstrumental = true;
      else if (e.kind === "quiet") ctx.isQuiet = true;
    }
  }
  return ctx;
}

// Candidate cut times to snap to: onset times + section start/end boundaries, sorted
// and de-duplicated (R-AC2 cut-on-onset).
export function cutBoundaries(audioEvents) {
  const out = new Set();
  for (const e of audioEvents?.events ?? []) {
    if (Number.isFinite(e.startSeconds)) out.add(round3(e.startSeconds));
    if (e.kind !== "onset" && Number.isFinite(e.endSeconds)) out.add(round3(e.endSeconds));
  }
  return [...out].sort((a, b) => a - b);
}

// Snap a time to the nearest boundary within tolerance, else leave it unchanged.
export function snapToBoundary(seconds, boundaries, tol) {
  let best = seconds;
  let bestD = tol;
  for (const b of boundaries) {
    const d = Math.abs(b - seconds);
    if (d <= bestD) {
      bestD = d;
      best = b;
    }
  }
  return round3(best);
}

// The aligned window grid. Prefer the saliency grid (so scores line up); fall back
// to a synthetic grid from the group's master-audio duration when saliency is absent.
function windowGrid(saliency, group, params) {
  const seen = new Map();
  for (const entries of Object.values(saliency?.angles ?? {})) {
    for (const e of entries) seen.set(e.startSeconds, { startSeconds: e.startSeconds, endSeconds: e.endSeconds });
  }
  if (seen.size > 0) return [...seen.values()].sort((a, b) => a.startSeconds - b.startSeconds);
  // Degraded: no saliency — synthesize a grid over the master-audio length (or the
  // longest video angle if the master id doesn't resolve).
  const master = group.members.find((m) => m.id === group.masterAudioId);
  const total = master?.durationSeconds ?? Math.max(0, ...group.members.map((m) => m.durationSeconds || 0));
  const ws = params.windowSeconds;
  const windows = [];
  for (let s = 0; s < total - 1e-9; s += ws) windows.push({ startSeconds: round3(s), endSeconds: round3(Math.min(s + ws, total)) });
  return windows;
}

// Per-angle lookup: startSeconds → saliency entry.
function entryIndex(saliency) {
  const idx = {};
  for (const [id, entries] of Object.entries(saliency?.angles ?? {})) {
    idx[id] = new Map(entries.map((e) => [e.startSeconds, e]));
  }
  return idx;
}

// The video angles, in input order (deterministic tie-break).
function videoAngles(group) {
  return group.members.filter((m) => m.kind === "video");
}

// Is `angle` usable at window `w`? With saliency, a window has an entry iff the
// angle has footage there; without saliency, fall back to the group offsets.
function availableAt(angle, w, entry, hasSaliency) {
  if (hasSaliency) return !!entry;
  return angleCoversWindow(w, angle);
}

// Weighted score for (angle, window). The audio priors (instrumental→instrument,
// vocal→performer) gate their terms by the section kind. `entry` is the VS-45
// saliency window (its `scores` always carries the five numeric keys); a window with
// footage but no saliency entry (degraded mode) scores neutral 0.
function scoreAt(entry, ctx, weights) {
  if (!entry) return 0;
  const s = entry.scores;
  return (
    weights.perf * s.performer +
    weights.inst * s.instrument * (ctx.isInstrumental ? 1 : 0) +
    weights.vocal * s.performer * (ctx.isVocal ? 1 : 0) +
    weights.motion * s.motion +
    weights.framing * s.framing
  );
}

function rationaleFor(angleId, entry, ctx) {
  if (!entry) return "only angle with footage";
  if (ctx.isInstrumental) return `instrumental → ${angleId} (inst ${round3(entry.scores.instrument)})`;
  if (ctx.isVocal) return `vocals → active singer ${angleId} (perf ${round3(entry.scores.performer)})`;
  return `highest saliency → ${angleId} (${round3(entry.saliency)})`;
}

// Main entry: produce { version, groupId, switches, rationale } from the synced
// group + audio events + saliency. `switches` is the existing exporter shape.
export function autoCut({ group, audioEvents = null, saliency = null, params = {} } = {}) {
  if (!group || !Array.isArray(group.members)) throw new Error("multicam-autocut: a group with members is required");
  const p = { ...DEFAULT_PARAMS, ...params, weights: { ...DEFAULT_PARAMS.weights, ...(params.weights || {}) } };
  const angles = videoAngles(group);
  if (angles.length === 0) throw new Error("multicam-autocut: the group has no video angles");

  const windows = windowGrid(saliency, group, p);
  if (windows.length === 0) throw new Error("multicam-autocut: no windows (need saliency or a master-audio duration)");
  const hasSaliency = Object.keys(saliency?.angles ?? {}).length > 0;
  const idx = entryIndex(saliency);
  const boundaries = cutBoundaries(audioEvents);

  const ws = round3(windows[0].endSeconds - windows[0].startSeconds);
  const minW = Math.max(1, Math.ceil(p.minShotSeconds / ws));
  const maxW = Math.max(minW, Math.floor(p.maxShotSeconds / ws));
  const longTakeW = Math.max(maxW, Math.floor(p.longTakeMaxSeconds / ws)); // hard ceiling for the exception

  // Precompute per-window context + per-angle score.
  const ctxOf = windows.map((w) => audioContextAt(audioEvents, (w.startSeconds + w.endSeconds) / 2));
  const entryOf = windows.map((w) => Object.fromEntries(angles.map((a) => [a.id, idx[a.id]?.get(w.startSeconds)])));
  const availOf = windows.map((w, wi) => angles.filter((a) => availableAt(a, w, entryOf[wi][a.id], hasSaliency)).map((a) => a.id));
  const scoreOf = windows.map((w, wi) => {
    const m = {};
    for (const a of angles) m[a.id] = availOf[wi].includes(a.id) ? scoreAt(entryOf[wi][a.id], ctxOf[wi], p.weights) : -Infinity;
    return m;
  });

  // Best available angle at a window (input order breaks ties), optionally excluding one.
  const bestAt = (wi, exclude) => {
    let best = null;
    let bestScore = -Infinity;
    for (const a of angles) {
      if (a.id === exclude) continue;
      const sc = scoreOf[wi][a.id];
      if (sc > bestScore) {
        bestScore = sc;
        best = a.id;
      }
    }
    return best;
  };

  // Single pass: hold the current angle, switching only when allowed (min-shot
  // hysteresis + challenger margin), forced to vary after max-shot, forced off a
  // dead angle (no footage). Produces a per-window choice.
  const chosen = new Array(windows.length);
  let cur = bestAt(0, null) ?? angles[0].id;
  let shotLen = 0;
  for (let wi = 0; wi < windows.length; wi++) {
    const curOk = availOf[wi].includes(cur);
    if (!curOk) {
      cur = bestAt(wi, null) ?? cur;
      shotLen = 0;
    } else if (shotLen >= maxW) {
      // Long-take exception (R-AC8): in a sustained instrumental stretch, let a
      // clearly dominant angle hold past maxShot (up to longTakeW) for solos / oner
      // shots, instead of forcing variety. Otherwise cut to the next-best valid angle.
      const runnerUp = bestAt(wi, cur);
      const dominant = cur === bestAt(wi, null)
        && (runnerUp == null || scoreOf[wi][cur] - scoreOf[wi][runnerUp] >= p.longTakeMargin);
      if (ctxOf[wi].isInstrumental && shotLen < longTakeW && dominant) {
        // hold: leave `cur`, keep counting shotLen toward the longTakeW ceiling
      } else {
        cur = runnerUp ?? cur; // force variety: next-best valid angle
        shotLen = 0;
      }
    } else {
      const best = bestAt(wi, null);
      if (best && best !== cur && shotLen >= minW && scoreOf[wi][best] - scoreOf[wi][cur] > p.switchMargin) {
        cur = best;
        shotLen = 0;
      }
    }
    chosen[wi] = cur;
    shotLen++;
  }

  // Collapse consecutive same-angle windows into shots → switches + rationale.
  const switches = [];
  const rationale = [];
  for (let wi = 0; wi < windows.length; wi++) {
    if (wi > 0 && chosen[wi] === chosen[wi - 1]) continue;
    const id = chosen[wi];
    let at;
    if (wi === 0) at = round3(p.startSeconds);
    else {
      const snapped = snapToBoundary(windows[wi].startSeconds, boundaries, p.snapToleranceSeconds);
      // Keep cuts strictly increasing and not before the trim start.
      at = round3(Math.max(p.startSeconds, snapped, switches[switches.length - 1].atSeconds + ws / 2));
    }
    const runnerUp = bestAt(wi, id);
    const conf = switchConfidence(scoreOf[wi][id], runnerUp == null ? null : scoreOf[wi][runnerUp], entryOf[wi][id]?.confidence ?? 1, p);
    switches.push({ atSeconds: at, memberId: id });
    rationale.push({ atSeconds: at, memberId: id, why: rationaleFor(id, entryOf[wi][id], ctxOf[wi]), runnerUp, confidence: conf.confidence, flagged: conf.flagged });
  }

  // Drop a runt trailing shot (VS-61): if the final switch lands within the model's
  // own minimum gap (`ws/2`, the same floor the inter-switch clamp above enforces) of
  // the timeline end, snapping produced a sub-frame trailing span — merge it back into
  // the previous shot rather than emit it.
  const timelineEnd = windows[windows.length - 1].endSeconds;
  while (switches.length > 1 && timelineEnd - switches[switches.length - 1].atSeconds < ws / 2) {
    switches.pop();
    rationale.pop();
  }

  return { version: AUTOCUT_VERSION, groupId: group.id, switches, rationale };
}

// --- Evaluation metrics (computable from the inputs, no human) — docs §6 ---------
// % of instrumental time whose on-screen angle has the highest `instrument` score,
// % of vocal time on a "singing" (highest `performer`) angle, shot-length stats.
export function evaluate({ group, audioEvents, saliency, switches }) {
  const angles = videoAngles(group);
  const idx = entryIndex(saliency);
  const windows = windowGrid(saliency, group, DEFAULT_PARAMS);
  // Active angle at a given time from the switch list.
  const activeAt = (t) => {
    let id = switches[0].memberId;
    for (const sw of switches) if (sw.atSeconds <= t) id = sw.memberId;
    return id;
  };
  let instWin = 0;
  let instHit = 0;
  let vocWin = 0;
  let vocHit = 0;
  for (const w of windows) {
    const c = (w.startSeconds + w.endSeconds) / 2;
    const ctx = audioContextAt(audioEvents, c);
    const active = activeAt(c);
    const top = (key) => {
      let bid = null;
      let bv = -Infinity;
      for (const a of angles) {
        const v = idx[a.id]?.get(w.startSeconds)?.scores?.[key] ?? -Infinity;
        if (v > bv) {
          bv = v;
          bid = a.id;
        }
      }
      return bid;
    };
    if (ctx.isInstrumental) {
      instWin++;
      if (active === top("instrument")) instHit++;
    }
    if (ctx.isVocal) {
      vocWin++;
      if (active === top("performer")) vocHit++;
    }
  }
  // Shot lengths from the switch boundaries (the last shot runs to the timeline end).
  const lengths = [];
  for (let i = 0; i < switches.length; i++) {
    const end = i + 1 < switches.length ? switches[i + 1].atSeconds : windows[windows.length - 1].endSeconds;
    lengths.push(round3(end - switches[i].atSeconds));
  }
  return {
    switches: switches.length,
    instrumentalOnInstrumentAngle: instWin ? round3(instHit / instWin) : null,
    vocalOnSingingAngle: vocWin ? round3(vocHit / vocWin) : null,
    shotLengths: lengths,
    minShot: Math.min(...lengths),
    maxShot: Math.max(...lengths),
  };
}

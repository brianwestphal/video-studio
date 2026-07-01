// Pure group-manifest + angle-cut assembly for audio-synced multi-cam
// (docs/multicam.md): turn measured per-clip offsets into a group manifest, gate
// sync confidence, and resolve angle switches into an editor-handoff cut spec. No
// I/O and no signal math — the DSP primitives (FFT cross-correlation, drift fit,
// retime) live in multicam-dsp.mjs; the ffmpeg run lives in sync-multicam.mjs.
// Split out of one file (VS-37) to keep each focused; held to 100% coverage.

// --- confidence gate ---------------------------------------------------------

// Classify a normalized confidence into a sync disposition:
//  "auto"   >= accept   (trust the measured offset)
//  "review" in between  (usable but flag for a human glance)
//  "manual" <  reject   (silent / non-overlapping audio — needs a manual offset)
export function classifySync(confidence, { accept = 0.8, reject = 0.5 } = {}) {
  if (confidence >= accept) return "auto";
  if (confidence < reject) return "manual";
  return "review";
}

// --- group manifest ----------------------------------------------------------

// Pick the sync reference for a group. An audio-only member (an external mic /
// field recorder) is preferred — it is both the sync reference AND the master
// audio (R-MC3); otherwise the longest member wins (most overlap to sync
// against), ties broken by input order.
export function selectReference(members) {
  if (members.length === 0) throw new Error("a group needs at least one member");
  const pool = members.some((m) => m.kind === "audio")
    ? members.filter((m) => m.kind === "audio")
    : members;
  let best = pool[0];
  for (const m of pool) {
    if ((m.durationSeconds ?? 0) > (best.durationSeconds ?? 0)) best = m;
  }
  return best;
}

// Assemble the group manifest from members already carrying their measured
// offset relative to the reference. Each input member:
//   { id, path, kind: "video"|"audio", fps?, durationSeconds?,
//     offsetSeconds, confidence, peakRatio?, sync?, driftPpm?,
//     rateCorrection?, correctedOffsetSeconds? }
// The reference is anchored at offset 0; the master audio is the audio-only
// member when present, else the reference. Members are not reordered.
// `rateCorrection` (1 = none) is the retime factor to run a drifting member on
// the reference clock; `correctedOffsetSeconds` is the start-anchored offset to
// use WITH that retime (vs `offsetSeconds`, the best single uncorrected offset).
export function buildGroupManifest({ id, projectFps, members }) {
  const reference = selectReference(members);
  const audioOnly = members.filter((m) => m.kind === "audio");
  const masterAudio = audioOnly.length === 1 ? audioOnly[0] : reference;
  return {
    id,
    projectFps,
    referenceId: reference.id,
    masterAudioId: masterAudio.id,
    members: members.map((m) => {
      const isRef = m.id === reference.id;
      const driftWarning = Math.abs(m.driftPpm ?? 0) > DRIFT_WARN_PPM;
      return {
        id: m.id,
        path: m.path,
        kind: m.kind,
        fps: m.fps ?? null,
        durationSeconds: m.durationSeconds ?? null,
        offsetSeconds: isRef ? 0 : m.offsetSeconds,
        confidence: isRef ? 1 : m.confidence,
        peakRatio: m.peakRatio ?? null,
        sync: isRef ? "reference" : (m.sync ?? classifySync(m.confidence)),
        driftPpm: m.driftPpm ?? null,
        driftWarning,
        rateCorrection: isRef ? 1 : (m.rateCorrection ?? 1),
        correctedOffsetSeconds: isRef ? 0 : (m.correctedOffsetSeconds ?? null),
      };
    }),
  };
}

// Beyond this absolute clock-drift rate, a single offset will visibly slip over
// a long take and the manifest flags the member for re-clocking / re-sync.
export const DRIFT_WARN_PPM = 100;

// --- angle switching ---------------------------------------------------------

// Resolve a list of angle switches over the shared group timeline into concrete
// segments that the editor handoff can cut. `switches` is [{ atSeconds, memberId
// }] (the group-timeline time at which that angle takes over); `members` supplies
// each member's offsetSeconds + durationSeconds. Returns segments:
//   { memberId, timelineInSeconds, timelineOutSeconds,
//     sourceInSeconds, sourceOutSeconds }
// where sourceIn = timelineIn - offset (the member's own clock). `totalSeconds`
// closes the final segment. Throws on an empty switch list or unknown memberId.
export function resolveAngleCuts(switches, members, { totalSeconds }) {
  if (switches.length === 0) throw new Error("resolveAngleCuts needs at least one switch");
  const byId = new Map(members.map((m) => [m.id, m]));
  const sorted = [...switches].sort((a, b) => a.atSeconds - b.atSeconds);
  const segments = [];
  for (let i = 0; i < sorted.length; i++) {
    const sw = sorted[i];
    const member = byId.get(sw.memberId);
    if (!member) throw new Error(`unknown memberId: ${sw.memberId}`);
    const tIn = sw.atSeconds;
    const tOut = i + 1 < sorted.length ? sorted[i + 1].atSeconds : totalSeconds;
    // With a drift `rateCorrection`, the member's clock runs at `rate` relative to
    // the reference: group_time = rate*member_local + correctedOffset, so
    // member_local = (group_time - correctedOffset) / rate. Without drift
    // (rate 1, no correctedOffset) this is the plain group_time - offset.
    const rate = member.rateCorrection ?? 1;
    const offset = member.correctedOffsetSeconds ?? member.offsetSeconds ?? 0;
    segments.push({
      memberId: member.id,
      timelineInSeconds: tIn,
      timelineOutSeconds: tOut,
      sourceInSeconds: (tIn - offset) / rate,
      sourceOutSeconds: (tOut - offset) / rate,
    });
  }
  return segments;
}

// Extract the `switches` list from a parsed switches.json (the `propose-switches`
// output, VS-46/47), tolerating either the full `{ version, switches, rationale }`
// document or a bare array. Invalid entries (missing/NaN `atSeconds` or empty
// `memberId`) are dropped, and each is normalized to `{ atSeconds, memberId }` so a
// hand-edited file can carry extra keys. Returns `[]` when absent, letting the CLI
// fall back to its single-span default. This is the glue that lets the auto-cut
// generator feed `export-multicam-fcpxml` / `render-multicam-preview` (R-MC7).
export function switchesFromDoc(doc) {
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.switches) ? doc.switches : [];
  return list
    .filter((s) => s && Number.isFinite(s.atSeconds) && typeof s.memberId === "string" && s.memberId.length > 0)
    .map((s) => ({ atSeconds: s.atSeconds, memberId: s.memberId }));
}

// Expand a synced group + angle switches into an editor-handoff CUT SPEC (the
// shape export-manifest.mjs consumes): a flat sequence of **silent** video angle
// segments over a **continuous master-audio track**. This is the "synced flat
// timeline" first cut (docs/multicam.md R-MC5/R-MC6); a true FCPXML multicam
// asset is export-multicam-fcpxml.mjs.
//
//  - `group` is a manifest group ({ projectFps, masterAudioId, members[] }).
//  - `switches` is [{ atSeconds, memberId }] over the shared timeline.
//  - `opts`: { name, width, height, totalSeconds? } — frame size is required by
//    the export; totalSeconds defaults to the master audio member's duration
//    (the event runs as long as the master audio).
//
// Returns { project, clips, audioTrack }. Each clip is
// { source, in, out, audio: "silent" }; audioTrack is
// { source, in, durationSeconds } for the master audio under the whole timeline.
export function expandMulticamGroup(group, switches, { name, width, height, totalSeconds } = {}) {
  const byId = new Map(group.members.map((m) => [m.id, m]));
  const master = byId.get(group.masterAudioId);
  if (!master) throw new Error(`master audio member not found: ${group.masterAudioId}`);
  const total = totalSeconds ?? master.durationSeconds;
  if (!(total > 0)) throw new Error("expandMulticamGroup: a positive totalSeconds (or master duration) is required");

  const segments = resolveAngleCuts(switches, group.members, { totalSeconds: total });
  const clips = segments.map((s) => {
    const rate = byId.get(s.memberId).rateCorrection ?? 1;
    return {
      source: byId.get(s.memberId).path,
      in: +s.sourceInSeconds.toFixed(3),
      out: +s.sourceOutSeconds.toFixed(3),
      audio: "silent",
      // A drifting angle is retimed on export so its source span fills the
      // timeline slot (the segment is silent, so only video is retimed).
      ...(rate !== 1 ? { rateCorrection: rate } : {}),
    };
  });

  // The master audio plays under the whole timeline; at timeline 0 its own clock
  // is (0 - masterOffset), so we read it from there.
  const masterOffset = master.offsetSeconds ?? 0;
  const audioTrack = { source: master.path, in: +(-masterOffset).toFixed(3), durationSeconds: +total.toFixed(3) };

  return {
    project: { name: name || group.id, fps: group.projectFps, width, height },
    clips,
    audioTrack,
  };
}

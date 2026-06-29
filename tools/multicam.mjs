// Pure logic for audio-synced multi-cam (docs/multicam.md): the DSP and manifest
// math that aligns several clips of one event by their audio, with no I/O. The
// ffmpeg audio extraction + the actual sync run live in sync-multicam.mjs; this
// module holds the testable core so it can be held to 100% coverage.
//
// Technique (confirmed by the VS-19/VS-27 deep research): condition each clip to
// mono, then recover a coarse per-clip offset by FFT cross-correlation in the
// frequency domain (O(N log N) via the convolution theorem), gate it with a
// normalized correlation-peak confidence, and express everything in SECONDS so
// non-integer / mismatched frame rates (29.97 vs 30) need no special handling.
// Clock drift over long takes is fit as a line offset(t) = slope*t + intercept
// and reported (midpoint offset + ppm); a single midpoint offset is enough for
// angle-switching cuts. Silent / non-overlapping audio shows up as low
// confidence and falls back to a manual offset.

// --- small numeric helpers ---------------------------------------------------

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Sum of products of two equal-length arrays (dot product).
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Subtract the mean so cross-correlation measures shape, not DC level. Returns a
// new Float64Array.
export function removeMean(samples) {
  const out = new Float64Array(samples.length);
  if (samples.length === 0) return out;
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length;
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] - mean;
  return out;
}

// A coarse amplitude envelope: rectify then box-smooth. Cross-correlating
// envelopes is robust to per-mic gain / frequency-response differences at low
// SNR (the secondary-camera-mic case), at the cost of fine precision.
export function envelope(samples, window = 64) {
  const n = samples.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const w = Math.max(1, Math.floor(window));
  let acc = 0;
  const buf = new Float64Array(w);
  let head = 0;
  let filled = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(samples[i]);
    acc += v - buf[head];
    buf[head] = v;
    head = (head + 1) % w;
    if (filled < w) filled++;
    out[i] = acc / filled;
  }
  return out;
}

// Condition a raw mono signal for correlation: optional envelope, then mean
// removal. `feature` is "raw" (waveform) or "envelope" (default, more robust).
export function condition(samples, { feature = "envelope", window = 64 } = {}) {
  const base = feature === "envelope" ? envelope(samples, window) : samples;
  return removeMean(base);
}

// --- FFT ---------------------------------------------------------------------

// In-place iterative radix-2 Cooley-Tukey FFT (length must be a power of two).
// `re`/`im` are Float64Array; `inverse` runs the IFFT (with 1/N scaling).
export function fftInPlace(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// Circular cross-correlation via FFT. Returns a real Float64Array `c` of length
// N = nextPow2(|ref|+|clip|) where c at circular index k equals
// sum_n ref[n+k]*clip[n]; map k>=N/2 to the negative lag k-N. Zero-padding to
// |ref|+|clip| keeps the wanted lags free of wraparound.
export function crossCorrelate(ref, clip) {
  const n = nextPow2(ref.length + clip.length);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(ref);
  br.set(clip);
  fftInPlace(ar, ai);
  fftInPlace(br, bi);
  for (let i = 0; i < n; i++) {
    // ar * conj(br)
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = re;
    ai[i] = im;
  }
  fftInPlace(ar, ai, true);
  return ar;
}

// GCC-PHAT cross-correlation: like crossCorrelate, but the cross-power spectrum
// is phase-transformed (whitened) — each bin divided by its own magnitude so
// only phase survives. That makes the correlation peak much sharper and far more
// robust at low SNR (the noisy secondary-mic case), at the cost of amplitude
// information. Bins below `eps` magnitude (silence) are left at zero.
export function crossCorrelatePhat(ref, clip, eps = 1e-9) {
  const n = nextPow2(ref.length + clip.length);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  ar.set(ref);
  br.set(clip);
  fftInPlace(ar, ai);
  fftInPlace(br, bi);
  for (let i = 0; i < n; i++) {
    // G = ar * conj(br), then G /= |G|
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    const mag = Math.hypot(re, im);
    if (mag > eps) {
      ar[i] = re / mag;
      ai[i] = im / mag;
    } else {
      ar[i] = 0;
      ai[i] = 0;
    }
  }
  fftInPlace(ar, ai, true);
  return ar;
}

// Sub-sample peak location: fit a parabola through three correlation samples
// straddling the peak (y at lags -1, 0, +1) and return the vertex offset in
// (-0.5, 0.5). Zero when the three points are flat / degenerate.
export function parabolicVertex(ym1, y0, yp1) {
  const denom = ym1 - 2 * y0 + yp1;
  if (denom === 0) return 0;
  return clamp((0.5 * (ym1 - yp1)) / denom, -0.5, 0.5);
}

// Map a circular index to a signed lag in (-n/2, n/2].
export function signedLag(index, n) {
  return index < n / 2 ? index : index - n;
}

// Recover the best integer-sample offset of `clip` relative to `ref`: the lag D
// where clip[i] best matches ref[i+D]. A positive D means the clip's content is
// later on the reference's timeline, i.e. the clip started LATER than the
// reference by D samples (so it is placed at +D on the shared timeline).
//
// Options:
//  - method: "standard" (amplitude cross-correlation, default) or "phat"
//    (GCC-PHAT — phase-whitened, sharper/noise-robust).
//  - interpolate: refine the integer peak to sub-sample precision via parabolic
//    interpolation (so `offsetSamples` may be fractional). Off by default.
//  - maxLagSamples: constrain the search to plausible offsets.
// Returns { offsetSamples, confidence, peakRatio }:
//  - confidence in [0,1]: for "standard" the normalized correlation peak
//    (peak / sqrt(Eref*Eclip)); for "phat" the peak distinctness 1 - second/peak
//    (PHAT whitening removes the amplitude a normalized peak would need).
//  - peakRatio: peak / next-best peak outside a guard window (Infinity when there
//    is no competing peak).
export function findOffset(ref, clip, { maxLagSamples = null, method = "standard", interpolate = false } = {}) {
  const c = method === "phat" ? crossCorrelatePhat(ref, clip) : crossCorrelate(ref, clip);
  const n = c.length;
  const within = (i) => maxLagSamples == null || Math.abs(signedLag(i, n)) <= maxLagSamples;

  let bestIdx = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < n; i++) {
    if (within(i) && c[i] > bestVal) {
      bestVal = c[i];
      bestIdx = i;
    }
  }

  const guard = Math.max(1, Math.round(n * 0.001));
  let second = -Infinity;
  for (let i = 0; i < n; i++) {
    if (Math.abs(i - bestIdx) <= guard) continue;
    if (within(i) && c[i] > second) second = c[i];
  }

  let confidence;
  if (method === "phat") {
    confidence = bestVal > 0 ? clamp(1 - Math.max(second, 0) / bestVal, 0, 1) : 0;
  } else {
    const energy = Math.sqrt(dot(ref, ref) * dot(clip, clip));
    confidence = energy > 0 ? clamp(bestVal / energy, 0, 1) : 0;
  }
  const peakRatio = second > 0 ? bestVal / second : Infinity;

  let offset = signedLag(bestIdx, n);
  if (interpolate) {
    offset += parabolicVertex(c[(bestIdx - 1 + n) % n], c[bestIdx], c[(bestIdx + 1) % n]);
  }
  return { offsetSamples: offset, confidence, peakRatio };
}

// Convenience: run findOffset and convert the offset to seconds at `sampleRate`.
export function offsetSeconds(ref, clip, sampleRate, opts = {}) {
  const r = findOffset(ref, clip, opts);
  return { ...r, seconds: r.offsetSamples / sampleRate };
}

// --- drift -------------------------------------------------------------------

// Least-squares fit of offset(t) = slope*t + intercept across >=2 measurements
// taken at different times within a clip. A single global offset cannot hold for
// long takes because recorder clocks drift (typically 5-50 ppm); the midpoint
// offset minimizes the worst-case residual (symmetric across the take). Returns
// { slopePpm, midpointOffsetSeconds, spanSeconds }.
export function fitDrift(points) {
  if (points.length < 2) throw new Error("fitDrift needs at least two points");
  let st = 0, so = 0, stt = 0, sto = 0;
  const n = points.length;
  for (const p of points) {
    st += p.atSeconds;
    so += p.offsetSeconds;
    stt += p.atSeconds * p.atSeconds;
    sto += p.atSeconds * p.offsetSeconds;
  }
  const denom = n * stt - st * st;
  const slope = denom === 0 ? 0 : (n * sto - st * so) / denom;
  const intercept = (so - slope * st) / n;
  let minT = points[0].atSeconds, maxT = points[0].atSeconds;
  for (const p of points) {
    if (p.atSeconds < minT) minT = p.atSeconds;
    if (p.atSeconds > maxT) maxT = p.atSeconds;
  }
  const mid = (minT + maxT) / 2;
  return {
    slopePpm: slope * 1e6,
    midpointOffsetSeconds: slope * mid + intercept,
    spanSeconds: maxT - minT,
  };
}

// Convert a measured drift rate into a retime correction. If the member's
// offset grows by `slope = driftPpm/1e6` seconds per second of its own time,
// then reference_time = (1 + slope)*member_time + const — so the member must be
// time-STRETCHED by `rate = 1 + slope` to run on the reference clock. `atempo`
// is the inverse playback-speed factor ffmpeg's atempo filter takes (output
// duration = input / atempo, so atempo = 1/rate). For drift correction the
// member's offset is then anchored at its START (the intercept), not the
// midpoint. Returns { rate, atempo }.
export function driftCorrection(driftPpm) {
  const rate = 1 + driftPpm / 1e6;
  return { rate, atempo: 1 / rate };
}

// Decompose an atempo factor into a chain each within ffmpeg's accepted
// [min,max] (default 0.5..2.0), multiplying back to the original factor — ppm
// corrections need a single element, but this keeps extreme factors valid.
// Returns an array of factors (always length >= 1).
export function atempoChain(factor, { min = 0.5, max = 2 } = {}) {
  if (!(factor > 0)) throw new Error("atempo factor must be positive");
  const chain = [];
  let remaining = factor;
  while (remaining > max) { chain.push(max); remaining /= max; }
  while (remaining < min) { chain.push(min); remaining /= min; }
  chain.push(remaining);
  return chain;
}

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
    const offset = member.offsetSeconds ?? 0;
    segments.push({
      memberId: member.id,
      timelineInSeconds: tIn,
      timelineOutSeconds: tOut,
      sourceInSeconds: tIn - offset,
      sourceOutSeconds: tOut - offset,
    });
  }
  return segments;
}

// Expand a synced group + angle switches into an editor-handoff CUT SPEC (the
// shape export-manifest.mjs consumes): a flat sequence of **silent** video angle
// segments over a **continuous master-audio track**. This is the "synced flat
// timeline" first cut (docs/multicam.md R-MC5/R-MC6); a true FCPXML multicam
// asset is a later milestone.
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
  const clips = segments.map((s) => ({
    source: byId.get(s.memberId).path,
    in: +s.sourceInSeconds.toFixed(3),
    out: +s.sourceOutSeconds.toFixed(3),
    audio: "silent",
  }));

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

// Pure non-speech audio-events analysis (docs/audio-events.md, R-AE). Turn a mono
// PCM signal (+ optional whisper word intervals) into an audio-events timeline: a
// loudness envelope, onset/accent events, quiet / vocal / instrumental sections,
// per-section spectral descriptors (Tier 2), and structural "section" events from
// spectral self-similarity novelty (Tier 2). No I/O — the ffmpeg mono extraction +
// whisper-JSON parse live in the thin CLI tools/analyze-audio-events.mjs. Held to
// 100% coverage (vitest.config).
import { fftInPlace } from "./multicam-dsp.mjs";

export const AUDIO_EVENTS_VERSION = 1;

const TWO_PI = 2 * Math.PI;
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;

// Short-window RMS loudness envelope: one value per hop. `rmsDb` is normalized to
// the track's peak hop (0 dB = loudest). Returns { hopSeconds, rms, rmsDb } where
// hopSeconds is the ACTUAL hop (whole samples) used.
export function rmsEnvelope(samples, { sampleRate, hopSeconds = 0.05 } = {}) {
  if (!(sampleRate > 0)) throw new Error("rmsEnvelope: a positive sampleRate is required");
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const rms = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += samples[j] * samples[j];
    rms.push(Math.sqrt(s / hop));
  }
  const peak = rms.reduce((m, r) => (r > m ? r : m), 0);
  const rmsDb = rms.map((r) => 20 * Math.log10((r + 1e-9) / (peak + 1e-9)));
  return { hopSeconds: hop / sampleRate, rms, rmsDb };
}

// Onsets/accents: positive RMS-flux peaks above `fluxRatio`×peak, with a
// refractory gap so a single hit isn't counted many times. Returns times (s).
export function detectOnsets({ rms, hopSeconds }, { fluxRatio = 0.06, refractorySeconds = 0.15 } = {}) {
  const peak = rms.reduce((m, r) => (r > m ? r : m), 0);
  const onsets = [];
  let last = -Infinity;
  for (let k = 1; k < rms.length; k++) {
    const t = k * hopSeconds;
    if (rms[k] - rms[k - 1] > fluxRatio * peak && t - last > refractorySeconds) {
      onsets.push(round3(t));
      last = t;
    }
  }
  return onsets;
}

// Merge word intervals (whisper `{start,end}`) into vocal spans: words within
// `gapSeconds` of each other join, and each span is padded by `padSeconds`
// (clamped to [0, total]). Input need not be sorted.
export function vocalSpans(words, totalSeconds, { gapSeconds = 1.5, padSeconds = 0.3 } = {}) {
  const ws = [...words].filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const spans = [];
  for (const w of ws) {
    const last = spans[spans.length - 1];
    if (last && w.start - last.end <= gapSeconds) {
      last.end = Math.max(last.end, w.end);
      last.wordCount++;
    } else {
      spans.push({ start: w.start, end: w.end, wordCount: 1 });
    }
  }
  return spans.map((s) => ({
    start: Math.max(0, s.start - padSeconds),
    end: Math.min(totalSeconds, s.end + padSeconds),
    wordCount: s.wordCount,
  }));
}

// Classify every envelope hop as "quiet" | "vocal" | "instrumental" (priority
// vocal > quiet > instrumental), then merge equal-adjacent hops into runs and
// absorb runs shorter than `minSpanSeconds` into a neighbour (so the sectioning
// doesn't flicker). Returns spans { kind, start, end, meanRmsDb, wordCount }.
export function sectionize(envelope, words, totalSeconds, { quietDb = -30, minSpanSeconds = 0.8, gapSeconds, padSeconds } = {}) {
  const { rmsDb, hopSeconds } = envelope;
  const vspans = vocalSpans(words, totalSeconds, { gapSeconds, padSeconds });
  const inVocal = (t) => vspansAt(vspans, t);

  const labels = rmsDb.map((db, k) => {
    const t = (k + 0.5) * hopSeconds;
    if (inVocal(t)) return "vocal";
    return db < quietDb ? "quiet" : "instrumental";
  });

  // equal-adjacent runs over hop indices [start, end)
  const runs = [];
  for (let k = 0; k < labels.length; k++) {
    const last = runs[runs.length - 1];
    if (last && last.kind === labels[k]) last.end = k + 1;
    else runs.push({ kind: labels[k], start: k, end: k + 1 });
  }

  // Absorb too-short runs into the previous run (keeping the previous kind), or —
  // for a short FIRST run — into the next, then coalesce adjacent same-kind runs
  // that the absorption may have produced. Keeps sections from flickering.
  const minHops = Math.max(1, Math.round(minSpanSeconds / hopSeconds));
  const absorbed = [];
  for (const run of runs) {
    if (absorbed.length && run.end - run.start < minHops) absorbed[absorbed.length - 1].end = run.end;
    else absorbed.push({ ...run });
  }
  if (absorbed.length > 1 && absorbed[0].end - absorbed[0].start < minHops) {
    absorbed[1].start = absorbed[0].start;
    absorbed.shift();
  }
  const merged = [];
  for (const run of absorbed) {
    const last = merged[merged.length - 1];
    if (last && last.kind === run.kind) last.end = run.end;
    else merged.push({ ...run });
  }

  return merged.map((run) => {
    const slice = rmsDb.slice(run.start, run.end);
    const meanRmsDb = slice.reduce((a, d) => a + d, 0) / slice.length;
    const start = run.start * hopSeconds;
    const end = Math.min(totalSeconds, run.end * hopSeconds);
    const wordCount = vspans.reduce((n, v) => n + (v.start < end && v.end > start ? v.wordCount : 0), 0);
    return { kind: run.kind, start: round3(start), end: round3(end), meanRmsDb: round1(meanRmsDb), wordCount };
  });
}

// True when time `t` falls inside any vocal span.
function vspansAt(vspans, t) {
  for (const v of vspans) if (t >= v.start && t < v.end) return true;
  return false;
}

// --- Tier 2: spectral descriptors + structural novelty (docs/audio-events.md §2) ---

// Per-window spectral descriptors via a Hann-windowed FFT (reusing `fftInPlace`
// from multicam-dsp.mjs). For each frame: spectral centroid & rolloff (Hz), the
// normalized positive spectral flux, the zero-crossing rate, and three normalized
// band-energy fractions (low/mid/high split at `bandEdgesHz`). `fftSize` must be a
// power of two. Returns { hopSeconds, fftSize, frames } where each frame carries
// its center `time` (seconds). Frames need `fftSize` samples, so a signal shorter
// than one window yields no frames.
export function spectralFeatures(samples, { sampleRate, fftSize = 1024, hopSeconds = 0.05, bandEdgesHz = [250, 2000], rolloffPercent = 0.85 } = {}) {
  if (!(sampleRate > 0)) throw new Error("spectralFeatures: a positive sampleRate is required");
  const hop = Math.max(1, Math.round(hopSeconds * sampleRate));
  const half = fftSize >> 1;
  const win = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (fftSize - 1));
  const freq = new Float64Array(half + 1);
  for (let b = 0; b <= half; b++) freq[b] = (b * sampleRate) / fftSize;
  const [bandLo, bandHi] = bandEdgesHz;

  const frames = [];
  let prev = null;
  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    let zc = 0;
    let prevSign = 0;
    for (let i = 0; i < fftSize; i++) {
      const x = samples[start + i];
      re[i] = x * win[i];
      const sign = x > 0 ? 1 : x < 0 ? -1 : 0;
      if (sign !== 0) {
        if (prevSign !== 0 && sign !== prevSign) zc++;
        prevSign = sign;
      }
    }
    fftInPlace(re, im);

    const mag = new Float64Array(half + 1);
    let total = 0;
    for (let b = 0; b <= half; b++) {
      const m = Math.hypot(re[b], im[b]);
      mag[b] = m;
      total += m;
    }
    const norm = total > 0 ? total : 1;

    let cw = 0;
    for (let b = 0; b <= half; b++) cw += freq[b] * mag[b];
    const centroidHz = total > 0 ? cw / total : 0;

    let cum = 0;
    let rolloffHz = 0;
    const thresh = rolloffPercent * total;
    for (let b = 0; b <= half; b++) {
      cum += mag[b];
      if (cum >= thresh) {
        rolloffHz = freq[b];
        break;
      }
    }

    let elo = 0;
    let emid = 0;
    let ehi = 0;
    for (let b = 0; b <= half; b++) {
      const e = mag[b] * mag[b];
      if (freq[b] < bandLo) elo += e;
      else if (freq[b] < bandHi) emid += e;
      else ehi += e;
    }
    const etot = elo + emid + ehi;
    const bands = etot > 0 ? [elo / etot, emid / etot, ehi / etot] : [0, 0, 0];

    let flux = 0;
    const unit = new Float64Array(half + 1);
    for (let b = 0; b <= half; b++) {
      const u = mag[b] / norm;
      unit[b] = u;
      if (prev) {
        const d = u - prev[b];
        if (d > 0) flux += d;
      }
    }
    prev = unit;

    frames.push({ time: (start + fftSize / 2) / sampleRate, centroidHz, rolloffHz, zcr: zc / (fftSize - 1), flux, bands });
  }
  return { hopSeconds: hop / sampleRate, fftSize, frames };
}

// Mean spectral descriptors over the frames whose center time falls in
// [start, end). Returns null when no frame is inside (so the caller can omit the
// `spectral` data rather than emit zeros).
export function aggregateSpectral(spec, start, end) {
  const inside = spec.frames.filter((f) => f.time >= start && f.time < end);
  if (inside.length === 0) return null;
  const mean = (sel) => inside.reduce((a, f) => a + sel(f), 0) / inside.length;
  return {
    centroidHz: Math.round(mean((f) => f.centroidHz)),
    rolloffHz: Math.round(mean((f) => f.rolloffHz)),
    zcr: round3(mean((f) => f.zcr)),
    flux: round3(mean((f) => f.flux)),
    bands: [0, 1, 2].map((i) => round3(mean((f) => f.bands[i]))),
  };
}

// Structural boundary times (seconds) from spectral self-similarity novelty. Each
// frame is reduced to a z-score-normalized [centroid, rolloff, zcr, lo, mid, hi]
// vector; novelty at frame i is the Euclidean distance between the mean vector of
// the preceding `windowSeconds` and that of the following `windowSeconds` (a
// checkerboard-style adjacent-window dissimilarity). Strict-local-maxima at or
// above `threshold`×peak and at least `minSegmentSeconds` apart become boundaries.
// Always returns [0, …boundaries, totalSeconds].
export function structureBoundaries(spec, totalSeconds, { windowSeconds = 4, threshold = 0.5, minSegmentSeconds = 4 } = {}) {
  const frames = spec.frames;
  const edges = [0, round3(totalSeconds)];
  if (frames.length < 2) return edges;

  const dims = [(f) => f.centroidHz, (f) => f.rolloffHz, (f) => f.zcr, (f) => f.bands[0], (f) => f.bands[1], (f) => f.bands[2]];
  const n = frames.length;
  const vecs = Array.from({ length: n }, () => new Float64Array(dims.length));
  dims.forEach((sel, d) => {
    const xs = frames.map(sel);
    const mu = xs.reduce((a, x) => a + x, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mu) * (x - mu), 0) / n) || 1;
    for (let i = 0; i < n; i++) vecs[i][d] = (xs[i] - mu) / sd;
  });

  const W = Math.max(1, Math.round(windowSeconds / spec.hopSeconds));
  const meanVec = (lo, hi) => {
    const m = new Float64Array(dims.length);
    for (let i = lo; i < hi; i++) for (let d = 0; d < dims.length; d++) m[d] += vecs[i][d];
    for (let d = 0; d < dims.length; d++) m[d] /= hi - lo;
    return m;
  };
  const novelty = new Float64Array(n);
  for (let i = W; i <= n - W; i++) {
    const left = meanVec(i - W, i);
    const right = meanVec(i, i + W);
    let s = 0;
    for (let d = 0; d < dims.length; d++) {
      const dd = left[d] - right[d];
      s += dd * dd;
    }
    novelty[i] = Math.sqrt(s);
  }
  let maxN = 0;
  for (let i = 0; i < n; i++) if (novelty[i] > maxN) maxN = novelty[i];
  if (!(maxN > 0)) return edges;

  const boundaries = [];
  for (let i = 1; i < n - 1; i++) {
    if (novelty[i] / maxN < threshold) continue;
    if (novelty[i] <= novelty[i - 1] || novelty[i] < novelty[i + 1]) continue;
    const t = round3(frames[i].time);
    if (boundaries.length && t - boundaries[boundaries.length - 1] < minSegmentSeconds) continue;
    boundaries.push(t);
  }
  return [0, ...boundaries, round3(totalSeconds)];
}

// Coarse timbre label for a structural section from its band balance (advisory).
function sectionLabel(sp) {
  if (!sp) return null;
  const [lo, mid, hi] = sp.bands;
  if (hi >= lo && hi >= mid) return "bright timbre";
  if (lo >= mid) return "low / warm timbre";
  return "mid timbre";
}

const DESCRIBE = {
  vocal: (s) => `Vocal section (${s.wordCount} word${s.wordCount === 1 ? "" : "s"}).`,
  instrumental: (s) => `Instrumental section (no lyrics, ${s.meanRmsDb.toFixed(0)} dB) — e.g. a riff or solo.`,
  quiet: () => "Quiet / silence (intro, break, or breath).",
};
const CONFIDENCE = { vocal: 0.9, instrumental: 0.7, quiet: 0.8 };

// Assemble the full audio-events.json object: a coarse envelope + sorted typed
// events (sections + onsets). Times are seconds on the source/group clock.
export function buildAudioEvents({ sourcePath, durationSeconds, sampleRate, envelope, samples = null, words = [], opts = {} }) {
  if (!(durationSeconds > 0)) throw new Error("buildAudioEvents: a positive durationSeconds is required");
  const onsets = detectOnsets(envelope, opts);
  const sections = sectionize(envelope, words, durationSeconds, opts);
  // Tier 2: per-window spectral descriptors (optional — needs the raw samples).
  const spec = samples ? spectralFeatures(samples, { sampleRate, hopSeconds: envelope.hopSeconds, fftSize: opts.fftSize, bandEdgesHz: opts.bandEdgesHz }) : null;

  const events = [];
  for (const s of sections) {
    const data = { meanRmsDb: s.meanRmsDb };
    if (s.kind === "vocal") data.wordCount = s.wordCount;
    if (spec) {
      const sp = aggregateSpectral(spec, s.start, s.end);
      if (sp) data.spectral = sp;
    }
    events.push({ kind: s.kind, startSeconds: s.start, endSeconds: s.end, confidence: CONFIDENCE[s.kind], description: DESCRIBE[s.kind](s), source: null, data });
  }
  // Tier 2: structural "section" events from spectral self-similarity novelty.
  if (spec) {
    const edges = structureBoundaries(spec, durationSeconds, opts);
    const count = edges.length - 1;
    for (let i = 0; i < count; i++) {
      const start = round3(edges[i]);
      const end = round3(edges[i + 1]);
      const sp = aggregateSpectral(spec, start, end);
      const label = sectionLabel(sp);
      const data = { index: i + 1, of: count };
      if (sp) data.spectral = sp;
      events.push({ kind: "section", startSeconds: start, endSeconds: end, confidence: 0.6, description: `Structural section ${i + 1}/${count}${label ? ` (${label})` : ""}.`, source: null, data });
    }
  }
  for (const t of onsets) {
    events.push({ kind: "onset", startSeconds: t, endSeconds: t, confidence: 0.7, description: "Audio accent / onset.", source: null, data: {} });
  }
  // sort by time; at equal times: content sections, then structural sections, then onsets (instants)
  const ord = (e) => (e.kind === "onset" ? 2 : e.kind === "section" ? 1 : 0);
  events.sort((a, b) => a.startSeconds - b.startSeconds || ord(a) - ord(b));

  return {
    version: AUDIO_EVENTS_VERSION,
    source: { path: sourcePath, durationSeconds: round3(durationSeconds), sampleRate },
    envelope: { hopSeconds: envelope.hopSeconds, rmsDb: envelope.rmsDb.map(round1) },
    events,
  };
}

// Parse a whisper JSON object (`{ segments: [{ words: [{word,start,end}] }] }`)
// into the flat word intervals the sectioniser wants, shifting by `offsetSeconds`
// (absolute time = clip start + word time). Tolerant of missing words/segments.
export function wordsFromWhisper(doc, offsetSeconds = 0) {
  const out = [];
  for (const seg of doc?.segments ?? []) {
    for (const w of seg?.words ?? []) {
      if (typeof w.start === "number" && typeof w.end === "number") {
        out.push({ start: w.start + offsetSeconds, end: w.end + offsetSeconds });
      }
    }
  }
  return out;
}

// Pure non-speech audio-events analysis (docs/audio-events.md, R-AE). Turn a mono
// PCM signal (+ optional whisper word intervals) into an audio-events timeline: a
// loudness envelope, onset/accent events, and quiet / vocal / instrumental
// sections. No I/O — the ffmpeg mono extraction + whisper-JSON parse live in the
// thin CLI tools/analyze-audio-events.mjs. Held to 100% coverage (vitest.config).

export const AUDIO_EVENTS_VERSION = 1;

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

const DESCRIBE = {
  vocal: (s) => `Vocal section (${s.wordCount} word${s.wordCount === 1 ? "" : "s"}).`,
  instrumental: (s) => `Instrumental section (no lyrics, ${s.meanRmsDb.toFixed(0)} dB) — e.g. a riff or solo.`,
  quiet: () => "Quiet / silence (intro, break, or breath).",
};
const CONFIDENCE = { vocal: 0.9, instrumental: 0.7, quiet: 0.8 };

// Assemble the full audio-events.json object: a coarse envelope + sorted typed
// events (sections + onsets). Times are seconds on the source/group clock.
export function buildAudioEvents({ sourcePath, durationSeconds, sampleRate, envelope, words = [], opts = {} }) {
  if (!(durationSeconds > 0)) throw new Error("buildAudioEvents: a positive durationSeconds is required");
  const onsets = detectOnsets(envelope, opts);
  const sections = sectionize(envelope, words, durationSeconds, opts);

  const events = [];
  for (const s of sections) {
    const e = { kind: s.kind, startSeconds: s.start, endSeconds: s.end, confidence: CONFIDENCE[s.kind], description: DESCRIBE[s.kind](s), source: null, data: { meanRmsDb: s.meanRmsDb } };
    if (s.kind === "vocal") e.data.wordCount = s.wordCount;
    events.push(e);
  }
  for (const t of onsets) {
    events.push({ kind: "onset", startSeconds: t, endSeconds: t, confidence: 0.7, description: "Audio accent / onset.", source: null, data: {} });
  }
  // sort by time; at equal times, sections (ranges) before onsets (instants)
  const ord = (e) => (e.kind === "onset" ? 1 : 0);
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

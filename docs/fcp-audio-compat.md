# FCP-incompatible source audio detection (requirements)

Status: **Shipped (VS-40)** — warn-only detection of WAV source audio that Final
Cut Pro's FCPXML importer would reject. Follow-up from
[`multicam.md`](multicam.md) / VS-36. Cross-referenced from
[`requirements.md`](requirements.md).

**Implementation:** pure RIFF parse + classification in
[`../tools/wav-compat.mjs`](../tools/wav-compat.mjs) (`parseRiffChunks`,
`classifyWavFcpCompat`, `fcpCompatWarning`; 100% unit-tested,
`tests/wav-compat.test.ts`); the file-header read + stderr warning in the thin I/O
wrapper [`../tools/wav-compat-io.mjs`](../tools/wav-compat-io.mjs) (`readRiffHeader`,
`warnFcpAudioCompat`; manual-test-plan §9), called by `sync-multicam` and
`export-multicam-fcpxml` on their audio members.

## 1. Why

Final Cut Pro's FCPXML media importer rejects some audio files that
ffmpeg/QuickTime read fine — notably **Pro Tools / Broadcast Wave (BWF)** WAVs
that carry a non-standard **40-byte `fmt ` chunk** (the canonical PCM `fmt ` is 16
bytes) plus extra metadata chunks (`bext`, `minf`, `elm1`, `regn`, `umid`, a
leading `JUNK`). FCP imports every edit referencing such a file as **"Invalid edit
with no respective media"** — the asset loads no media, so the master audio track
is **silent**. The BYAM test WAV in `external/multi-cam/` is exactly this case
(`BYAM-audio.wav`); VS-36's workaround re-encodes it to a canonical WAV
(`BYAM-audio-clean.wav`) in `external/multi-cam/build.mjs`:

```
ffmpeg -fflags +bitexact -i in.wav -map_metadata -1 -c:a pcm_s16le -ac 2 -ar 48000 out.wav
```

The FCPXML the toolkit generates is itself correct and DTD-valid (VS-36); this is
purely about **source-media compatibility ergonomics** — telling the user before
they hit a silent import.

## 2. Behaviour

- A WAV is **FCP-safe** when it is a RIFF/WAVE container with a canonical 16-byte
  PCM `fmt ` chunk and **no** BWF / Pro Tools metadata chunks.
- It **needs normalization** when, for PCM (`audioFormat == 1`), the `fmt ` chunk
  is not 16 bytes, **or** any of `bext` / `minf` / `elm1` / `regn` / `umid` /
  `JUNK` is present (matched case-insensitively).
- Non-WAV inputs (camera `.mov`/`.mp4`, truncated/unreadable reads) are reported
  as **not a WAV** and pass silently — the check only concerns WAV source audio.
- **Policy: warn-only.** When an audio member needs normalization, the toolkit
  prints a loud stderr warning (naming the file, the reasons, the silent-import
  symptom, and the exact `ffmpeg` fix) but does **not** modify or repoint media.
  Auto-normalize-and-repoint is intentionally deferred (see §5) — it writes a new
  file next to the source, which should be an explicit opt-in.

## 3. Requirements

- **R-FA1** A pure detector parses the RIFF chunk table from a file's leading
  bytes (stopping at the `data` chunk) and classifies a WAV as FCP-safe vs
  needs-normalization per §2. No I/O, no new dependencies. 100%-covered.
- **R-FA2** `sync-multicam` and `export-multicam-fcpxml` check each **audio
  member** and warn (stderr) when its WAV would not import into FCP, citing the
  reasons and the canonical `ffmpeg` re-encode. The check never throws or aborts
  the sync/export (a read failure is ignored).
- **R-FA3** Warn-only: the toolkit does not rewrite or repoint source media. The
  `ffmpeg` normalization itself stays a manual/pipeline step (manual-test-plan §9).
- **R-FA4** Non-WAV and unreadable inputs are treated as safe (no false warnings
  on camera video files).

## 4. Out of scope

The FCPXML generation (correct + DTD-valid, VS-36); non-WAV audio containers;
repairing the audio (re-encoding is the documented manual `ffmpeg` step); deep BWF
metadata parsing beyond chunk presence.

## 5. Follow-ups

- **Opt-in auto-normalize (VS-53)** — an explicit flag that, on detecting an
  FCP-incompatible WAV, writes a canonical sidecar (`<name>.fcp.wav`) and repoints
  the export at it, so the FCP import "just works" without a manual re-encode.

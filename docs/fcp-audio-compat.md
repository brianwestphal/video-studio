# FCP-incompatible source audio detection (requirements)

Status: **Shipped (VS-40 detection + VS-53 opt-in auto-normalize)** — detect WAV
source audio that Final Cut Pro's FCPXML importer would reject and, by default,
warn; with `--fcp-normalize-audio`, write a canonical sidecar and repoint the
export at it. Follow-up from [`multicam.md`](multicam.md) / VS-36. Cross-referenced
from [`requirements.md`](requirements.md).

**Implementation:** pure RIFF parse + classification + path/argv helpers in
[`../tools/wav-compat.mjs`](../tools/wav-compat.mjs) (`parseRiffChunks`,
`classifyWavFcpCompat`, `fcpCompatWarning`, `fcpSidecarPath`, `fcpNormalizeArgs`;
100% unit-tested, `tests/wav-compat.test.ts`); the file-header read + warn/normalize
orchestration in the thin I/O wrapper
[`../tools/wav-compat-io.mjs`](../tools/wav-compat-io.mjs) (`readRiffHeader`,
`ensureFcpCompatAudio`; manual-test-plan §9), called by `sync-multicam` and
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
- **Default policy: warn-only.** When an audio member needs normalization, the
  toolkit prints a loud stderr warning (naming the file, the reasons, the
  silent-import symptom, and the exact `ffmpeg` fix) but does **not** modify or
  repoint media.
- **Opt-in auto-normalize (`--fcp-normalize-audio`, VS-53).** When the flag is set
  and a member needs normalization, the toolkit re-encodes it to a canonical
  **`<name>.fcp.wav`** sidecar **next to the source** (the maintainer's choice over
  a temp/output dir, so the FCPXML asset has a stable path that outlives the run)
  and **repoints** the manifest / FCPXML asset at it. A sidecar that already exists
  and is at least as new as the source is **reused** (no re-encode). Off by default
  because it writes a new file beside the source.

## 3. Requirements

- **R-FA1** A pure detector parses the RIFF chunk table from a file's leading
  bytes (stopping at the `data` chunk) and classifies a WAV as FCP-safe vs
  needs-normalization per §2. No I/O, no new dependencies. 100%-covered.
- **R-FA2** `sync-multicam` and `export-multicam-fcpxml` check each **audio
  member** and warn (stderr) when its WAV would not import into FCP, citing the
  reasons and the canonical `ffmpeg` re-encode. The check never throws or aborts
  the sync/export (a read failure is ignored).
- **R-FA3** Default warn-only: without the flag, the toolkit does not rewrite or
  repoint source media.
- **R-FA4** Non-WAV and unreadable inputs are treated as safe (no false warnings
  on camera video files).
- **R-FA5** (VS-53) With `--fcp-normalize-audio`, a needs-normalization member is
  re-encoded to a canonical `<name>.fcp.wav` sidecar **next to the source** and the
  manifest / FCPXML asset is **repointed** at it. The pure pieces — the sidecar
  **path** (`fcpSidecarPath`) and the `ffmpeg` **argv** (`fcpNormalizeArgs`) — are
  100%-covered; the re-encode run is manual/pipeline. An up-to-date sidecar is
  reused (no redundant re-encode).

## 4. Out of scope

The FCPXML generation (correct + DTD-valid, VS-36); non-WAV audio containers; deep
BWF metadata parsing beyond chunk presence.

## 5. Follow-ups

None open. (VS-53 — opt-in auto-normalize — is now shipped, above.)

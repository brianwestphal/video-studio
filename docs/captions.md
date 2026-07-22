# Captions and subtitles (VS-111)

Captions are a first-class export choice, distinct from the existing one-off animated
caption/lower-third overlays. A project may generate captions from speech recognition or
import an authored subtitle file, then export a sidecar, an embedded selectable track, or
burned-in styled text.

Status: **Design complete; implementation deferred to follow-up tickets.** The existing
`render-caption` tool remains the engine for animated graphic overlays; continuous dialogue
captions need their own timed-text model and renderer.

## 1. Timed-text source and project artifact

- **R-CAP1** A project can use a Whisper word-timestamp JSON file or import **SRT, WebVTT,
  or TTML**. Parsing produces one versioned, normalized `captions.json` artifact containing
  ordered cues (`startSeconds`, `endSeconds`, `text`) plus source/language metadata.
- **R-CAP2** Automatic generation is explicit and local: the UI names Whisper, lets the user
  select a language or auto-detect, reports progress, and never replaces an authored
  `captions.json` without confirmation.
- **R-CAP3** Cue generation preserves words, prevents overlapping cues, clamps cues to the
  edited program, and favors readable phrase boundaries. Defaults target at most two lines,
  roughly 42 characters per line, and 1–7 seconds per cue; the normalized artifact remains
  editable before export.
- **R-CAP4** When the cut removes or reorders source ranges, caption timing follows the final
  program timeline. Multi-camera angle changes do not duplicate dialogue; single-source
  range edits remap source timestamps into output timestamps.

## 2. Export modes and formats

- **R-CAP5** Export offers three explicit, mutually understandable modes: **Off**, **Sidecar
  file**, **Embedded selectable track**, and **Burn into video**. The chosen mode is recorded
  in the export manifest; no caption mode is silently inferred.
- **R-CAP6** Sidecar export supports **SRT**, **WebVTT**, and **TTML**, uses the finished
  video's basename, and reports the written path beside the video result.
- **R-CAP7** Embedded captions are a selectable subtitle track in compatible containers:
  `mov_text` for MP4/MOV and WebVTT for WebM. The UI disables incompatible format/container
  combinations with an explanation rather than silently burning or dropping captions.
- **R-CAP8** Burn-in uses ffmpeg-compatible subtitle rendering and is available for MP4 and
  social exports. FCPXML exports carry a sidecar/reference instead of rasterizing text, so
  captions remain editable in the NLE.
- **R-CAP9** Every output is validated: sidecars parse back to equivalent cues; embedded
  tracks appear in `ffprobe`; burn-in renders sample frames; caption duration never exceeds
  the finished program.

## 3. Styling and accessibility

- **R-CAP10** Burn-in exposes presets plus advanced controls for font family, size, weight,
  text color, background/outline, safe-area position, alignment, and maximum lines. Defaults
  are high-contrast, respect title-safe margins, and adapt between 16:9 and 9:16.
- **R-CAP11** Style is stored as data in the project/export manifest and produces a stable
  preview. Missing fonts fall back with a visible warning. User text and style values are
  escaped safely before entering ffmpeg/ASS filters.
- **R-CAP12** Captions preserve Unicode and speaker labels, may identify language, and allow
  an SDH cue to be marked without treating it as spoken dialogue. The UI previews the exact
  cues/style and offers a caption on/off comparison before a long render.

## 4. Relationship to existing overlays

`tools/render-caption.mjs` continues to render short animated title/lower-third/CTA graphics.
Continuous timed captions use `captions.json` and the export pipeline. A future implementation
may share typography helpers, but it must not turn hundreds of dialogue cues into independent
Chromium overlay renders.

## 5. Planned implementation slices

1. Pure timed-text normalization, SRT/WebVTT/TTML parsing/serialization, and cut-time remapping.
2. Export integration for sidecar, embedded, and burned-in modes with validation.
3. Desktop generation/import controls, styling, preview, and manifest persistence.

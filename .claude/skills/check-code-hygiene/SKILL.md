---
name: check-code-hygiene
description: Check video-studio code for standardization, readability, maintenance complexity, and defensive coding
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the video-studio codebase for hygiene issues — standardization, human
readability, maintenance complexity, and defensive coding. Generate a report.

Scope: `src/`, `bin/`, `tools/`, and `tests/`. Skip `promo-assets/` (worked
examples, not shipped; tracked in VS-8) unless something there bleeds into the
published package.

## Analysis areas

### 1. Standardization
- **File naming.** `src/` is kebab-case; a filename should mirror its primary
  export where there is one (`scene-math.ts` exports the scene math;
  `caption-format.mjs` exports the caption formatters). Flag a name that matches
  neither convention nor its primary export.
- **Module layout.** Pure, testable logic belongs in `src/scene-math.ts` /
  `tools/caption-format.mjs` (no import-time side effects). Orchestration with
  I/O belongs in `src/analyzer.ts` / `tools/render-caption.mjs` / `bin/`. Flag
  pure logic that has leaked back into an entry file, or a side effect that has
  leaked into a "pure" module.
- **Identifier casing.** camelCase values, PascalCase types, SCREAMING_SNAKE
  module constants (`SCENE_THRESHOLD`, `MIN_SCENE_SEC`, `DEFAULT_MODEL`,
  `STATE_VERSION`). Flag inconsistencies.
- **Import order / `.js` extensions.** `src/` is NodeNext — relative imports
  must use the `.js` extension (`./scene-math.js`). eslint-plugin-simple-import-sort
  enforces order; if `npm run lint` is clean, ordering is fine. The `.js`
  extension check is yours.
- **Error message style.** The analyzer throws *resumable* errors with a message
  + actionable instructions (`ResumableError`, `classifyOllamaError`). New
  user-facing failures should follow that pattern; flag terse
  `throw new Error('failed')` throws on a user path.

### 2. Human readability
- **File length.** Flag any file in `src/`/`tools/` growing past ~250 LOC
  without a reason — that's usually a sign more pure logic should be extracted.
- **Function length / nesting.** Flag functions over ~50 lines or nesting deeper
  than 3 levels (`runAnalysis` in `analyzer.ts` is the longest — watch it).
- **Magic numbers.** Tuning values should be named module constants. The fade
  keyframe tables (`IN_STEPS`/`OUT_STEPS`) and `SCENE_THRESHOLD`/`MIN_SCENE_SEC`
  are already named — flag any new bare literal that should be.
- **Comments.** Style is "why, not what." A block explaining a non-obvious
  decision (atomic state write, `-ss` before `-i` for fast seek, the baked
  hold-frame) is a feature; a comment paraphrasing the next line is noise. Flag
  both missing-when-needed and noise-when-not.

### 3. Maintenance complexity
- **Coupling.** `analyzer.ts` → `scene-math.ts` and `render-caption.mjs` →
  `caption-format.mjs` are the intended one-way dependencies. Flag any new
  cross-coupling or a back-import from a pure module into an entry file.
- **Shared mutable state.** The analyzer's state object is threaded through
  `runAnalysis` and persisted; there should be no module-level mutable
  singletons. Flag any new one.
- **Branching.** `parseArgs` (both CLIs) is a flag chain — appropriate. Flag any
  new chain > ~8 branches that wants a lookup table.
- **Duplicate patterns.** Spot-check with grep for repeated ffmpeg-arg or
  CSS-string builders that could be shared helpers.

### 4. Defensive coding
- **Boundary validation.** Verify each public boundary rejects bad input with an
  informative error, not silent misbehavior:
  - analyzer `parseArgs`: unknown flags / missing video → non-zero exit + usage.
  - analyzer: missing video file, undeterminable duration/fps → clear error.
  - `render-caption`/`caption-format` `parseArgs`: missing `--text`/`--out`,
    unknown flag → exit 2.
- **Error boundaries.** Selective catches with a reason are good (state-read
  fallback in `loadState`, Ollama error classification). Flag any blanket
  `try { … } catch { /* swallow */ }` with no rationale.
- **Null safety.** `strict` + `noUncheckedIndexedAccess` are on, so most is
  compiler-caught. Flag any new non-null assertion `!` in `src/` (tests get a
  pass) that isn't obviously safe.
- **Type safety.** Grep `src/` for `: any`, `as any`, `<any>`. Prefer `unknown`
  + narrowing. Flag any `any`.

## Report format

For each finding: **File** (path:line), **Category** (standardization /
readability / maintenance / defensive), **Severity** (high/medium/low),
**Description**, **Suggestion**.

End with a prioritized top-N (video-studio is small — expect 0–5 in a healthy
state). Suggest Hot Sheet tickets (`hs-task` for cleanups, `hs-bug` for real
defects) for non-trivial findings.

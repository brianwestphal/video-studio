---
name: analyze-code-quality
description: Run all tests and linters, check for anti-patterns, and generate a comprehensive code-quality report for video-studio
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the overall quality of the video-studio codebase and generate a
structured report. This project is small (a TS scene analyzer + `.mjs`
launcher/tools + a Claude skill), so expect a short, focused report.

## Steps

1. **Run unit tests with coverage**
   ```
   npm test
   ```
   Report: total tests, pass/fail, and the coverage table. Coverage is enforced
   at **100% lines/branches/functions/statements** but only on the pure modules
   in `vitest.config.ts` `coverage.include` (`src/scene-math.ts`,
   `tools/caption-format.mjs`). Flag any drop below 100% on those. The
   external-tool code (analyzer pipeline, launcher, `render-caption.mjs`
   Chromium path) is intentionally **not** covered here — it's in
   `docs/manual-test-plan.md`; do not flag it as missing coverage, but DO check
   the manual plan still lists it (step 6).

2. **Run the linter**
   ```
   npm run lint
   ```
   Report total errors/warnings grouped by rule. Note `@typescript-eslint/no-explicit-any` is `warn` — call out any new `any`.

3. **Run typecheck**
   ```
   npm run typecheck
   ```
   Report any type errors.

4. **Build**
   ```
   npm run build
   ```
   Confirm `dist/analyzer.js` + `dist/analyzer.d.ts` emit cleanly.

5. **Check for anti-patterns** (read `CLAUDE.md`, `docs/requirements.md`, and
   `docs/ai/codebase-map.md` first):
   - **Side effects on import.** `src/analyzer.ts` and `tools/render-caption.mjs`
     call `main()` — but each must be guarded so importing the module doesn't run
     it (render-caption uses an `import.meta.url === process.argv[1]` guard).
     Pure logic must stay in `src/scene-math.ts` / `tools/caption-format.mjs`
     with **no top-level side effects** so it stays unit-testable. Flag any pure
     helper that grows an import-time side effect.
   - **`any` leaks.** Grep `src/` for `: any\b`, `as any\b`, `<any>`. The
     codebase prefers `unknown` + narrowing (see `classifyOllamaError`). Flag any.
   - **Dependency creep.** Open `package.json`; runtime `dependencies` should be
     just `domotion-svg`, `fluent-ffmpeg`, `ollama`. Anything else is a finding.
   - **Hardcoded machine paths.** Grep for absolute `/Users/...` paths in
     shipped code (`src/`, `bin/`, `tools/`). (Known: `promo-assets/` has them —
     tracked in VS-8; flag any NEW ones in shipped dirs.)
   - **fps assumptions.** The toolkit is "24fps-aware but probe each video."
     Flag any new code that hardcodes 24 instead of using the probed fps.
   - **Duplicated logic** between `analyzer.ts` and `scene-math.ts`, or
     `render-caption.mjs` and `caption-format.mjs` (the split should be clean —
     no copy of a pure function left behind in the entry file).

6. **Verify the package shape**
   ```
   npm pack --dry-run
   ```
   Confirm the tarball includes `bin`, `dist`, `src`, `skills`, `tools`,
   `README.md`, `CHANGELOG.md`, `LICENSE` and does NOT include `analysis-data/`,
   `frames/`, `coverage/`, or test files. (Skip if it errors on local npm cache
   perms — CI's `npm-dry-run` job is authoritative.)

## Report format

- **Summary** — tests pass/fail, coverage on the two pure modules, lint clean,
  typecheck clean, build clean.
- **Test results** — counts + the per-file coverage table.
- **Lint issues** — grouped by rule.
- **Type issues** — grouped by file.
- **Anti-pattern violations** — file:line, severity (high/medium/low), one-line
  fix each.
- **Package shape** — pass/fail per check from step 6.
- **Recommendations** — prioritized. For non-trivial findings, suggest filing a
  Hot Sheet ticket (`hs-task` / `hs-bug`).

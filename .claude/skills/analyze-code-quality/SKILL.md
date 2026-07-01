---
name: analyze-code-quality
description: Run all tests and linters, audit stateful modules for untested state transitions (not just line coverage), check for anti-patterns, and generate a comprehensive code-quality report for video-studio
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
   in `vitest.config.ts` `coverage.include`. That list is the source of truth —
   read it from the file rather than trusting this doc — and currently holds:
   `src/scene-math.ts`, `src/resumable-error.ts`, `src/analyzer-cli.ts`,
   `src/analyzer-state.ts`, `tools/caption-format.mjs`, `tools/export-manifest.mjs`,
   `tools/fcpxml.mjs`, `tools/sources.mjs`, `tools/multicam.mjs`,
   `tools/multicam-dsp.mjs`, `tools/multicam-groups.mjs`, `tools/audio-events.mjs`,
   `tools/wav-compat.mjs`, `tools/transitions-render.mjs`,
   `tools/visual-saliency.mjs`, `tools/multicam-autocut.mjs`. Flag any drop below
   100% on those. The I/O code (`analyzer.ts` orchestration, `src/ffmpeg.ts`,
   `src/ollama.ts`, the launcher, `render-caption.mjs`'s Chromium path) is
   intentionally **not** covered here — it's in `docs/manual-test-plan.md`; do not
   flag it as missing coverage, but DO check the manual plan still lists it.

   **100% coverage is a floor, not a ceiling.** A green 100% table proves every
   line/branch *executed* during the suite — it says **nothing** about whether every
   documented *behavior*, and every *sequence* of operations, is actually
   **asserted**. Bugs that live in an untested interaction or state transition sail
   through a 100% report because the individual lines still get hit by isolated,
   from-clean-state tests. So do **not** treat 100% as "done": treat it as the
   trigger to run the **behavioral / state-transition audit** (step 2 below). Two
   critical bugs have shipped in a stateful module of this codebase under full
   100% coverage precisely because the transitions between its internal states were
   never exercised.

2. **Behavioral / state-transition audit** (the part line coverage is blind to)

   Line/branch/function coverage cannot see a *missing* behavior or a *missing
   transition* — only lines that don't exist can be "uncovered", and a bug of
   omission has no line. This step finds those gaps.

   **a. Identify the stateful modules.** Walk `coverage.include` (and any new pure
   module) and flag any module that is **stateful**, using this heuristic — it has
   one or more of:
   - multiple code paths keyed on an internal **mode / flag / phase**;
   - an explicit or implicit **state machine** (a "current" value that carries
     across calls or across iterations of a loop);
   - a **cache with fallback paths** (hit / miss / stale / partial / version-mismatch);
   - **lifecycle transitions** (init → in-progress → resume → done).

   Concrete examples in this codebase (verify they still exist; correct the list if
   modules were renamed/removed):
   - **`src/analyzer-state.ts`** — resumable-run cache. States: no cache, fresh
     cache, **stale** cache (video changed / `STATE_VERSION` bumped), **partial**
     cache (some scene descriptions present, some missing → resume). The bug-prone
     part is the transitions *between* runs, not any single read/write.
   - **`src/resumable-error.ts`** — error classification driving retry vs. abort.
   - **`tools/multicam-autocut.mjs`** — carries a **held angle** across scoring
     windows (switch-vs-hold is a per-window state transition governed by shot-length
     and margin constraints).
   - **`tools/audio-events.mjs`** — sectioning across a stream (vocal / instrumental
     / quiet segments with entry/exit boundaries).

   **b. For each stateful module, enumerate its states and the transitions between
   them**, then check the tests: do they exercise **multi-step sequences that cross
   state boundaries**, or only each operation once **from a clean initial state**?
   A module can sit at 100% line coverage with *every* transition untested if each
   test starts fresh.

   **c. Flag any stateful module whose tests are single-operation-from-clean-state**
   and recommend an **adversarial transition-matrix test**. Give concrete sequences
   to try, e.g.:
   - **out-of-order** — apply operations in a non-canonical order (resume before a
     full run; write description before scenes exist);
   - **interleaved** — two concerns advancing in alternation rather than one-then-the-other;
   - **repeated** — the same operation twice (idempotence; second call must not
     corrupt or double-count);
   - **empty-then-refill** — drain to empty, then add again (does the "empty" branch
     leave stale state that poisons the refill?);
   - **stale/version boundary** — the input the state was keyed to changes underneath
     it (file mtime/size, `STATE_VERSION`), forcing the fallback path.

   Report, per stateful module: its states, whether the transition matrix is
   covered, and the specific untested transitions (this is the deliverable that a
   100%-coverage-but-transition-blind module must be flagged on).

3. **Run the linter**
   ```
   npm run lint
   ```
   Report total errors/warnings grouped by rule. Note `@typescript-eslint/no-explicit-any` is `warn` — call out any new `any`.

4. **Run typecheck**
   ```
   npm run typecheck
   ```
   Report any type errors.

5. **Build**
   ```
   npm run build
   ```
   Confirm `dist/analyzer.js` + `dist/analyzer.d.ts` emit cleanly.

6. **Check for anti-patterns** (read `CLAUDE.md`, `docs/requirements.md`, and
   `docs/ai/codebase-map.md` first):
   - **Side effects on import.** The pure modules (everything in
     `vitest.config.ts` `coverage.include` — see step 1) must have **no top-level
     side effects** so they stay unit-testable. The entry files run on execution:
     `src/analyzer.ts` calls
     `main()` (it's the bin, never imported by tests), and `tools/render-caption.mjs`
     guards its `main()` with an `import.meta.url === process.argv[1]` check. Flag
     any pure module that grows an import-time side effect (fs/network/`process.exit`).
   - **`any` leaks.** Grep `src/` for `: any\b`, `as any\b`, `<any>`. The
     codebase prefers `unknown` + narrowing (see `classifyOllamaError` in
     `src/resumable-error.ts`). Flag any.
   - **Dependency creep.** Open `package.json`; runtime `dependencies` should be
     just `domotion-svg`, `fluent-ffmpeg`, `ollama`. Anything else is a finding.
   - **Hardcoded machine paths.** Grep for absolute `/Users/...` paths in shipped
     code (`src/`, `bin/`, `tools/`, `promo-assets/*.{mjs,sh}`, `scripts/`).
     `tests/packaging.test.ts` already guards this — flag any new occurrence (and
     confirm that test still runs).
   - **fps assumptions.** The toolkit is "24fps-aware but probe each video."
     Flag any new code that hardcodes 24 instead of using the probed fps.
   - **Duplicated logic** between `analyzer.ts` and its extracted modules, or
     `render-caption.mjs` and `caption-format.mjs` (the split should be clean —
     no copy of a pure function left behind in the entry file).

7. **Verify the package shape**
   ```
   npm pack --dry-run
   ```
   Confirm the tarball includes `bin`, `dist`, `src`, `skills`, `tools`,
   `promo-assets/*.{mjs,sh}`, `tsconfig.json`, `README.md`, `CHANGELOG.md`,
   `LICENSE` and does NOT include `analysis-data/`, `frames/`, `coverage/`, or test
   files. (The authoritative allow-list is `package.json` `files` — read it rather
   than trusting this list. Skip if it errors on local npm cache perms — CI's
   `npm-dry-run` job is authoritative.)

## Report format

- **Summary** — tests pass/fail, coverage on the pure modules, lint clean,
  typecheck clean, build clean, and a one-line **transition-coverage verdict**
  (which stateful modules, if any, have untested transitions).
- **Test results** — counts + the per-file coverage table.
- **Behavioral / state-transition audit** — per stateful module: its states, whether
  the transition matrix is covered, and any specific untested transitions. Flag any
  stateful module covered only single-operation-from-clean-state **even if its line
  coverage is 100%**, with the concrete adversarial sequences to add.
- **Lint issues** — grouped by rule.
- **Type issues** — grouped by file.
- **Anti-pattern violations** — file:line, severity (high/medium/low), one-line
  fix each.
- **Package shape** — pass/fail per check from step 7.
- **Recommendations** — prioritized. For non-trivial findings, suggest filing a
  Hot Sheet ticket (`hs-task` / `hs-bug`).

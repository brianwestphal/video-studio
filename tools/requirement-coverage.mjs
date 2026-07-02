// Feature/requirement coverage — the axis line coverage can't express (VS-58).
//
// Line/branch coverage proves every *line executed*; it says nothing about whether
// every documented *behavior* (or *sequence* of behaviors) is *asserted*. This
// module is the pure core of that second axis: it extracts the canonical requirement
// index from the docs and audits it against a hand-maintained coverage manifest that
// records, per requirement, *how* a regression would be caught. `check-features.mjs`
// (the CLI) and `tests/conventions.test.ts` (the gate) supply the file I/O; all the
// logic here is pure + side-effect-free so it is unit-tested to 100%.
//
// See docs/feature-coverage.md.

// A requirement is *defined* where its id is the first bolded token of a Markdown
// list item — e.g. `- **R4.3** ...` or `- **R-MC1 Grouping.** ...`. That anchor
// distinguishes a definition from a prose cross-reference (`see R-MC4`) or an
// unrelated token (`EBU R128`), so the index stays clean across all the docs even
// though they word their bullets differently.
export const REQUIREMENT_DEF_RE = /^\s*[-*]\s*\*\*(R(?:-[A-Z]{1,4})?\d+(?:\.\d+)?[a-z]?)\b/;

// Valid `status` values in the coverage manifest. `unit` requires ≥1 asserting test;
// the rest are deliberate "not a unit test, and here's why" classifications.
export const VERIFICATION_STATUSES = ["unit", "manual", "review", "gate", "deferred"];

// Extract the canonical, in-order, de-duplicated requirement ids defined in one
// Markdown document. Order follows first definition; duplicates collapse.
export function extractRequirementIds(markdown) {
  const ids = [];
  const seen = new Set();
  for (const line of String(markdown ?? "").split("\n")) {
    const m = line.match(REQUIREMENT_DEF_RE);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

// The coverage manifest: every documented requirement -> how its regression is
// caught. `status: "unit"` MUST list the asserting test file(s) (basenames under
// tests/); `manual` = the external-tool pipeline (docs/manual-test-plan.md); `review`
// = prose/skill guidance verified by human review; `gate` = enforced by a tooling
// gate (coverage thresholds, `npm run check`, CI, release); `deferred` = designed,
// intentionally not built yet. The audit flags any documented id missing here, any
// entry here no longer in the docs, and any `unit` entry with no test — so a new
// behavior (or a newly-shipped design-only one) forces a conscious coverage decision.
export const REQUIREMENT_COVERAGE = {
  // Platform & deps + launcher — external-tool detection/installation in the bin.
  "R2.1": { status: "manual", note: "launcher macOS guard (bin/video-studio.mjs)" },
  "R2.2": { status: "manual", note: "tool presence checks (Node/ffmpeg/claude)" },
  "R2.3": { status: "manual", note: "whisper presence check" },
  "R2.4": { status: "manual", note: "Ollama optional path" },
  "R2.5": { status: "manual", note: "detect/report/brew-install offer" },
  "R3.1": { status: "manual", note: "default launcher run" },
  "R3.2": { status: "manual", note: "--check/--doctor" },
  "R3.3": { status: "manual", note: "--no-launch" },
  "R3.4": { status: "manual", note: "--skills-only" },
  "R3.5": { status: "manual", note: "--yes/-y" },
  "R3.6": { status: "manual", note: "--help/-h" },
  "R3.7": { status: "manual", note: "skill install + {{TOOLKIT_DIR}} substitution" },

  // Scene analyzer — pure math/state/arg logic is unit-tested; ffmpeg/ollama I/O manual.
  "R4.1": { status: "manual", note: "ffprobe duration/fps probe" },
  "R4.2": { status: "manual", note: "ffmpeg full-decode scene detection" },
  "R4.3": { status: "unit", tests: ["scene-math.test.ts"] },
  "R4.4": { status: "manual", note: "ffmpeg representative-frame extraction" },
  "R4.5": { status: "unit", tests: ["scene-math.test.ts"], note: "timeline shape + timecode formatting (file write manual)" },
  "R4.6": { status: "unit", tests: ["analyzer-cli.test.ts"], note: "--describe/--model parsing; ollama fill manual" },
  "R4.7": { status: "unit", tests: ["analyzer-state.test.ts"] },
  "R4.8": { status: "unit", tests: ["resumable-error.test.ts"] },

  // Overlay generator — pure arg-parse + SVG assembly unit-tested; Chromium render manual.
  "R5.1": { status: "unit", tests: ["caption-format.test.ts"], note: "SVG assembly; svg-to-video render manual" },
  "R5.2": { status: "unit", tests: ["caption-format.test.ts"] },
  "R5.3": { status: "unit", tests: ["caption-format.test.ts"] },
  "R5.4": { status: "unit", tests: ["caption-format.test.ts"] },
  "R5.5": { status: "unit", tests: ["caption-format.test.ts"] },

  // The skill — prose guidance for Claude, verified by review + the manual plan.
  "R6.1": { status: "review", note: "skill prose (skills/video-studio/SKILL.md)" },
  "R6.2": { status: "review", note: "cut archetypes in SKILL.md" },
  "R6.3": { status: "review", note: "always-finish-and-verify guidance" },
  "R6.4": { status: "review", note: "output conventions in SKILL.md" },
  "R6.5": { status: "review", note: "durable intermediates; committed examples in docs/samples/" },

  // Quality gates — enforced by tooling, not asserted by a single test.
  "R7.1": { status: "gate", note: "vitest 100% thresholds + conventions.test.ts pins coverage.include" },
  "R7.2": { status: "gate", note: "docs/manual-test-plan.md present (conventions.test.ts)" },
  "R7.3": { status: "gate", note: "npm run check + CI" },
  "R7.4": { status: "gate", note: "tag-driven release with provenance (docs/releasing.md)" },
  "R7.5": { status: "unit", tests: ["requirement-coverage.test.ts", "conventions.test.ts"], note: "feature-coverage audit; also gated by check:features" },

  // Feature/requirement coverage (this system's own requirements) — docs/feature-coverage.md.
  "R-EC1": { status: "unit", tests: ["requirement-coverage.test.ts"], note: "extractRequirementIds index" },
  "R-EC2": { status: "unit", tests: ["requirement-coverage.test.ts"], note: "coverage manifest + status audit" },
  "R-EC3": { status: "unit", tests: ["conventions.test.ts", "requirement-coverage.test.ts"], note: "gate also runs via check:features" },
  "R-EC4": { status: "review", note: "transitions treated as first-class behaviors (policy; CLAUDE.md + analyze-code-quality skill)" },

  // Editor handoff — manifest/segment/fcpxml logic unit-tested; encode + FCP import manual.
  "R-EH1": { status: "unit", tests: ["export-manifest.test.ts"], note: "segment numbering (encode manual)" },
  "R-EH2": { status: "unit", tests: ["export-manifest.test.ts"], note: "ProRes 422 HQ segment argv" },
  "R-EH3": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH4": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH5": { status: "unit", tests: ["export-manifest.test.ts"], note: "ProRes 4444 overlay argv" },
  "R-EH6": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH7": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH8": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH9": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH9a": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH9b": { status: "unit", tests: ["export-manifest.test.ts"] },
  "R-EH10": { status: "unit", tests: ["export-manifest.test.ts"], note: "rebuild.sh sufficiency" },
  "R-EH11": { status: "unit", tests: ["fcpxml.test.ts"], note: "DTD-valid FCPXML" },
  "R-EH12": { status: "unit", tests: ["fcpxml.test.ts"] },
  "R-EH13": { status: "manual", note: "FCP import validation (VS-25/36)" },

  // Multiple sources — id/manifest logic unit-tested; per-source analyze run manual.
  "R-MS1": { status: "unit", tests: ["sources.test.ts"] },
  "R-MS2": { status: "unit", tests: ["sources.test.ts"] },
  "R-MS3": { status: "unit", tests: ["sources.test.ts"] },
  "R-MS4": { status: "unit", tests: ["sources.test.ts"] },
  "R-MS5": { status: "unit", tests: ["sources.test.ts"] },
  "R-MS6": { status: "unit", tests: ["sources.test.ts"], note: "per-source analyze run manual" },
  "R-MS7": { status: "unit", tests: ["sources.test.ts"] },

  // FCP transition suggestions — FCPXML <transition> generation unit-tested.
  "R-TR1": { status: "unit", tests: ["fcpxml.test.ts"] },
  "R-TR2": { status: "unit", tests: ["fcpxml.test.ts"] },
  "R-TR3": { status: "unit", tests: ["fcpxml.test.ts"] },
  "R-TR4": { status: "unit", tests: ["fcpxml.test.ts"] },
  "R-TR5": { status: "unit", tests: ["fcpxml.test.ts"] },

  // Render transitions into the video — pure recipe/plan logic unit-tested; render manual.
  "R-RT1": { status: "unit", tests: ["transitions-render.test.ts"], note: "windowed render plan (ffmpeg render manual)" },
  "R-RT2": { status: "unit", tests: ["transitions-render.test.ts"] },
  "R-RT3": { status: "unit", tests: ["transitions-render.test.ts"] },
  "R-RT4": { status: "unit", tests: ["transitions-render.test.ts"] },
  "R-RT5": { status: "unit", tests: ["transitions-render.test.ts"] },
  "R-RT6": { status: "unit", tests: ["transitions-render.test.ts"] },
  "R-RT7": { status: "unit", tests: ["transitions-render.test.ts"] },
  "R-RT8": { status: "unit", tests: ["transitions-render.test.ts"] },
  "R-RT9": { status: "unit", tests: ["transitions-render.test.ts"] },

  // Multi-cam editing — group/angle math unit-tested; sync + export runs manual.
  "R-MC1": { status: "unit", tests: ["multicam-groups.test.ts", "multicam.test.ts"] },
  "R-MC2": { status: "unit", tests: ["multicam-dsp.test.ts"], note: "audio sync (run manual)" },
  "R-MC3": { status: "unit", tests: ["multicam.test.ts"] },
  "R-MC4": { status: "unit", tests: ["multicam.test.ts"] },
  "R-MC5": { status: "unit", tests: ["multicam.test.ts"] },
  "R-MC6": { status: "unit", tests: ["multicam.test.ts", "fcpxml.test.ts"], note: "FCP import manual" },
  "R-MC7": { status: "unit", tests: ["multicam.test.ts", "multicam-autocut.test.ts"], note: "auto angle selection: switchesFromDoc glue + selector; CLI --switches wiring + skill step manual (VS-46/47)" },

  // Multi-cam sync — pure DSP unit-tested; the ffmpeg extract + run is manual.
  "R-MCS1": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS2": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS3": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS4": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS5": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS6": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS7": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS8": { status: "unit", tests: ["multicam-dsp.test.ts"] },
  "R-MCS9": { status: "manual", note: "ffmpeg mono extract + sync run" },

  // FCP-incompatible source audio — pure RIFF parse/classify unit-tested; re-encode manual.
  "R-FA1": { status: "unit", tests: ["wav-compat.test.ts"] },
  "R-FA2": { status: "unit", tests: ["wav-compat.test.ts"] },
  "R-FA3": { status: "unit", tests: ["wav-compat.test.ts"] },
  "R-FA4": { status: "unit", tests: ["wav-compat.test.ts"], note: "--fcp-normalize-audio re-encode manual" },
  "R-FA5": { status: "unit", tests: ["wav-compat.test.ts"] },

  // Audio events — pure DSP/merge unit-tested; ffmpeg/whisper extraction manual.
  "R-AE1": { status: "unit", tests: ["audio-events.test.ts"] },
  "R-AE2": { status: "unit", tests: ["audio-events.test.ts"] },
  "R-AE3": { status: "unit", tests: ["audio-events.test.ts"] },
  "R-AE4": { status: "unit", tests: ["audio-events.test.ts"] },
  "R-AE5": { status: "deferred", note: "optional stem separation (Demucs) — VS-48" },
  "R-AE6": { status: "unit", tests: ["audio-events.test.ts"] },
  "R-AE7": { status: "unit", tests: ["audio-events.test.ts"] },
  "R-AE8": { status: "unit", tests: ["audio-events.test.ts"] },

  // Per-angle visual saliency — pure core unit-tested; motion pass + Ollama vision manual.
  "R-VS1": { status: "unit", tests: ["visual-saliency.test.ts"] },
  "R-VS2": { status: "unit", tests: ["visual-saliency.test.ts"] },
  "R-VS3": { status: "unit", tests: ["visual-saliency.test.ts"], note: "ffmpeg motion + Ollama vision run manual" },
  "R-VS4": { status: "unit", tests: ["visual-saliency.test.ts"] },
  "R-VS5": { status: "unit", tests: ["visual-saliency.test.ts"] },

  // Auto multi-cam cutting — pure selector unit-tested; the thin CLI is manual.
  "R-AC1": { status: "unit", tests: ["multicam-autocut.test.ts"] },
  "R-AC2": { status: "unit", tests: ["multicam-autocut.test.ts"] },
  "R-AC3": { status: "unit", tests: ["multicam-autocut.test.ts"] },
  "R-AC4": { status: "unit", tests: ["multicam-autocut.test.ts"] },
  "R-AC5": { status: "unit", tests: ["multicam-autocut.test.ts"] },
  "R-AC6": { status: "manual", note: "propose-switches CLI I/O" },
  "R-AC7": { status: "unit", tests: ["multicam.test.ts"], note: "switchesFromDoc glue for --switches; CLI wiring + skill step manual (VS-47)" },
  "R-AC8": { status: "unit", tests: ["multicam-autocut.test.ts"], note: "shot-length policy (max 8/min 0.5) + instrumental long-take exception (VS-62)" },
  "R-AC9": { status: "unit", tests: ["multicam-autocut.test.ts"], note: "per-switch review signal: runnerUp/confidence/flagged (VS-63)" },

  // Multi-cam review UI — docs/multicam-review-ui.md. Flag signal R-AC9 + the pure
  // review-model core are unit-tested; the server/browser/ffmpeg shell is manual (VS-65).
  // Downstream re-evaluation (R-RUI7, VS-66) is still design-only.
  "R-RUI1": { status: "manual", note: "review-switches CLI + localhost server launch (VS-65)" },
  "R-RUI2": { status: "unit", tests: ["review-model.test.ts"], note: "reviewSegments flag filtering (--all vs flagged-only)" },
  "R-RUI3": { status: "unit", tests: ["review-model.test.ts"], note: "candidateAngles + ±context preview windows; ffmpeg extraction itself manual" },
  "R-RUI4": { status: "unit", tests: ["review-model.test.ts"], note: "applyReview applies per-segment picks" },
  "R-RUI5": { status: "unit", tests: ["review-model.test.ts"], note: "applyReview change history; in-place write-back + .bak manual" },
  "R-RUI6": { status: "manual", note: "print export handoff line after save (VS-65)" },
  "R-RUI7": { status: "unit", tests: ["multicam-autocut.test.ts"], note: "autoCut locks + shot-type variety penalty (VS-66); wiring the UI save to re-propose is VS-67" },
  "R-RUI8": { status: "manual", note: "per-segment synchronized transport, single audio-focus, fullscreen; clips retain audio (VS-71); scrubber section-of-interest band + tick (VS-72) — manual-test-plan §13.9-13.13" },
  "R-RUI9": { status: "manual", note: "whole-video assembled timeline preview — client-side multi-cam player over HTTP-Range /source, /assembled edit, angle-colored bar, live pick updates (VS-73) — manual-test-plan §13.14-13.17" },
  "R-RUI10": { status: "unit", tests: ["review-model.test.ts"], note: "force-add via reviewSegments forceKeys + splitSwitch are unit-tested; the /add-review, /split, and docked-timeline-drawer UI are I/O (manual-test-plan §13.18-13.21) (VS-74)" },
};

// Audit the manifest against the ids actually defined in the docs. Pure: caller
// supplies both sides. Returns the three coverage failures that a green 100%
// line-coverage report is structurally blind to.
export function auditRequirementCoverage(definedIds, coverage = REQUIREMENT_COVERAGE) {
  const defined = [...new Set(definedIds)];
  const definedSet = new Set(defined);
  const missing = defined.filter((id) => !(id in coverage));
  const orphaned = Object.keys(coverage).filter((id) => !definedSet.has(id));
  const invalid = [];
  const unverified = [];
  for (const [id, entry] of Object.entries(coverage)) {
    if (!entry || !VERIFICATION_STATUSES.includes(entry.status)) {
      invalid.push(id);
      continue;
    }
    if (entry.status === "unit" && !(Array.isArray(entry.tests) && entry.tests.length > 0)) {
      unverified.push(id);
    }
  }
  return { missing, orphaned, invalid, unverified };
}

// Which `unit` entries name a test file that does not exist. Caller passes the set
// of real test basenames (I/O stays in the CLI/gate); this stays pure.
export function unresolvedTestRefs(coverage, existingTestBasenames) {
  const existing = existingTestBasenames instanceof Set ? existingTestBasenames : new Set(existingTestBasenames);
  const out = [];
  for (const [id, entry] of Object.entries(coverage)) {
    if (entry?.status !== "unit" || !Array.isArray(entry.tests)) continue;
    for (const test of entry.tests) {
      if (!existing.has(test)) out.push({ id, test });
    }
  }
  return out;
}

// Count requirements by verification status — the one-line dashboard for the report.
export function summarizeCoverage(coverage = REQUIREMENT_COVERAGE) {
  const counts = Object.fromEntries(VERIFICATION_STATUSES.map((s) => [s, 0]));
  let invalid = 0;
  for (const entry of Object.values(coverage)) {
    if (entry && VERIFICATION_STATUSES.includes(entry.status)) counts[entry.status] += 1;
    else invalid += 1;
  }
  return { total: Object.keys(coverage).length, counts, invalid };
}

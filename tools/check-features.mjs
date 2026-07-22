#!/usr/bin/env node
/**
 * check-features — the feature/requirement coverage report (VS-58, R7.1).
 *
 * Orthogonal to the line/branch coverage report: it walks the canonical requirement
 * index (every `- **R<id>**` definition in docs/*.md) and, via the coverage manifest
 * in ./requirement-coverage.mjs, asserts that *every documented behavior* is
 * accounted for by an asserting test (or a deliberate manual/review/gate/deferred
 * classification). It flags:
 *   - documented requirements missing from the manifest (a new behavior with no
 *     coverage decision),
 *   - manifest entries no longer in the docs (stale),
 *   - `unit` entries with no test, or naming a test file that does not exist.
 *
 * Exit code is non-zero on any gap, so it drops into `npm run check` / CI.
 *
 * Usage: node tools/check-features.mjs [--json]
 *
 * The parsing + audit logic is pure in ./requirement-coverage.mjs (100% unit-tested);
 * this file is only the file I/O + reporting.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditRequirementCoverage,
  extractRequirementIds,
  REQUIREMENT_COVERAGE,
  summarizeCoverage,
  unresolvedTestRefs,
} from "./requirement-coverage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DOCS_DIR = join(ROOT, "docs");
const TESTS_DIR = join(ROOT, "tests");

// Every top-level docs/*.md is a potential requirement source of truth; the ai/
// summaries reference requirements but don't define them (no `- **R<id>**` bullets),
// so scanning them is harmless but we keep to the canonical docs.
export function collectDefinedRequirements(docsDir = DOCS_DIR) {
  const perDoc = {};
  const ids = [];
  const seen = new Set();
  for (const name of readdirSync(docsDir).filter((f) => f.endsWith(".md")).sort()) {
    const found = extractRequirementIds(readFileSync(join(docsDir, name), "utf8"));
    if (found.length) perDoc[name] = found;
    for (const id of found) {
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return { ids, perDoc };
}

function existingTestBasenames(testsDir = TESTS_DIR) {
  return new Set(
    readdirSync(testsDir).filter(
      (f) => f.endsWith(".test.ts") || f.endsWith(".test.tsx") || f.endsWith(".test.mjs"),
    ),
  );
}

export function runCheck() {
  const { ids, perDoc } = collectDefinedRequirements();
  const audit = auditRequirementCoverage(ids, REQUIREMENT_COVERAGE);
  const unresolved = unresolvedTestRefs(REQUIREMENT_COVERAGE, existingTestBasenames());
  const summary = summarizeCoverage(REQUIREMENT_COVERAGE);
  const ok =
    audit.missing.length === 0 &&
    audit.orphaned.length === 0 &&
    audit.invalid.length === 0 &&
    audit.unverified.length === 0 &&
    unresolved.length === 0;
  return { ids, perDoc, audit, unresolved, summary, ok };
}

function main(argv) {
  const asJson = argv.includes("--json");
  const result = runCheck();
  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    process.exit(result.ok ? 0 : 1);
  }

  const { audit, unresolved, summary, ids } = result;
  const lines = [];
  lines.push(`Feature / requirement coverage — ${ids.length} documented requirements`);
  lines.push(
    `  unit: ${summary.counts.unit}  manual: ${summary.counts.manual}  review: ${summary.counts.review}  ` +
      `gate: ${summary.counts.gate}  deferred: ${summary.counts.deferred}`,
  );
  const report = (label, arr, render = (x) => x) => {
    if (arr.length === 0) return;
    lines.push("");
    lines.push(`${label} (${arr.length}):`);
    for (const item of arr) lines.push(`  - ${render(item)}`);
  };
  report("MISSING from manifest — documented but no coverage decision", audit.missing);
  report("ORPHANED in manifest — no longer in the docs", audit.orphaned);
  report("INVALID status", audit.invalid);
  report("UNVERIFIED — status 'unit' but no asserting test listed", audit.unverified);
  report("UNRESOLVED test file — named test does not exist", unresolved, (u) => `${u.id} -> tests/${u.test}`);

  lines.push("");
  lines.push(result.ok ? "OK — every documented requirement has a coverage decision." : "FAIL — coverage gaps above.");
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

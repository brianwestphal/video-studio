import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module, no types
import {
  auditRequirementCoverage,
  extractRequirementIds,
  REQUIREMENT_COVERAGE,
  REQUIREMENT_DEF_RE,
  summarizeCoverage,
  unresolvedTestRefs,
  VERIFICATION_STATUSES,
} from "../tools/requirement-coverage.mjs";

describe("extractRequirementIds", () => {
  it("extracts ids defined at the start of a bulleted list item", () => {
    const md = [
      "- **R2.1** macOS only.",
      "* **R-MC1 Grouping.** explicit groups",
      "- **R-EH9a** audioTrack recorded",
    ].join("\n");
    expect(extractRequirementIds(md)).toEqual(["R2.1", "R-MC1", "R-EH9a"]);
  });

  it("ignores prose cross-references and non-requirement tokens", () => {
    const md = [
      "The audio-sync requirements (R-MC2/3/4) are shipped.",
      "an EBU-R128-style loudness backbone (R128)",
      "| gated by whisper (R6.5 transcripts) | note |",
      "- **Review** of the repository", // bold word starting with R but no digit
    ].join("\n");
    expect(extractRequirementIds(md)).toEqual([]);
  });

  it("de-duplicates, preserving first-definition order", () => {
    const md = ["- **R4.3** first", "- **R4.3** again", "- **R4.1** later"].join("\n");
    expect(extractRequirementIds(md)).toEqual(["R4.3", "R4.1"]);
  });

  it("treats null/undefined input as empty", () => {
    expect(extractRequirementIds(undefined)).toEqual([]);
    expect(extractRequirementIds(null)).toEqual([]);
  });

  it("exposes the definition regex", () => {
    expect(REQUIREMENT_DEF_RE.test("- **R-VS5** something")).toBe(true);
    expect(REQUIREMENT_DEF_RE.test("see R-VS5 elsewhere")).toBe(false);
  });
});

describe("auditRequirementCoverage", () => {
  it("reports nothing wrong when the manifest exactly matches the docs", () => {
    const coverage = { "R1.1": { status: "unit", tests: ["a.test.ts"] } };
    expect(auditRequirementCoverage(["R1.1"], coverage)).toEqual({
      missing: [],
      orphaned: [],
      invalid: [],
      unverified: [],
    });
  });

  it("flags documented ids missing from the manifest and stale orphans", () => {
    const coverage = { "R1.1": { status: "manual", note: "x" } };
    const res = auditRequirementCoverage(["R1.1", "R2.2"], coverage);
    expect(res.missing).toEqual(["R2.2"]);
    expect(res.orphaned).toEqual([]);
  });

  it("flags manifest entries no longer defined in the docs", () => {
    const coverage = { "R1.1": { status: "manual", note: "x" }, "R9.9": { status: "manual", note: "y" } };
    const res = auditRequirementCoverage(["R1.1"], coverage);
    expect(res.orphaned).toEqual(["R9.9"]);
  });

  it("de-duplicates the defined-id input", () => {
    const coverage = { "R1.1": { status: "manual", note: "x" } };
    const res = auditRequirementCoverage(["R1.1", "R1.1"], coverage);
    expect(res.missing).toEqual([]);
    expect(res.orphaned).toEqual([]);
  });

  it("flags invalid entries: null and unknown status", () => {
    const coverage = { "R1.1": null, "R1.2": { status: "bogus" } };
    const res = auditRequirementCoverage(["R1.1", "R1.2"], coverage);
    expect(res.invalid.sort()).toEqual(["R1.1", "R1.2"]);
  });

  it("flags unit entries with a missing or empty tests list as unverified", () => {
    const coverage = {
      "R1.1": { status: "unit" },
      "R1.2": { status: "unit", tests: [] },
      "R1.3": { status: "unit", tests: ["ok.test.ts"] },
    };
    const res = auditRequirementCoverage(["R1.1", "R1.2", "R1.3"], coverage);
    expect(res.unverified.sort()).toEqual(["R1.1", "R1.2"]);
  });

  it("defaults to the real project manifest", () => {
    const res = auditRequirementCoverage(Object.keys(REQUIREMENT_COVERAGE));
    expect(res.missing).toEqual([]);
    expect(res.invalid).toEqual([]);
    expect(res.unverified).toEqual([]);
  });
});

describe("unresolvedTestRefs", () => {
  const coverage = {
    "R1.1": { status: "unit", tests: ["present.test.ts", "gone.test.ts"] },
    "R1.2": { status: "manual", note: "x" },
    "R1.3": { status: "unit", note: "no tests array" },
  };

  it("returns unit entries naming a non-existent test file (array input)", () => {
    expect(unresolvedTestRefs(coverage, ["present.test.ts"])).toEqual([{ id: "R1.1", test: "gone.test.ts" }]);
  });

  it("accepts a Set of existing basenames", () => {
    expect(unresolvedTestRefs(coverage, new Set(["present.test.ts", "gone.test.ts"]))).toEqual([]);
  });

  it("every listed test in the real manifest exists", () => {
    // Guards against a manifest that names a test file that was renamed/removed.
    // (The authoritative on-disk check lives in conventions.test.ts.)
    const named = new Set(
      Object.values(REQUIREMENT_COVERAGE)
        .filter((e: { tests?: string[] }) => Array.isArray(e.tests))
        .flatMap((e: { tests: string[] }) => e.tests),
    );
    expect(unresolvedTestRefs(REQUIREMENT_COVERAGE, named)).toEqual([]);
  });
});

describe("summarizeCoverage", () => {
  it("counts requirements by status and tallies invalid entries", () => {
    const coverage = {
      "R1.1": { status: "unit", tests: ["a.test.ts"] },
      "R1.2": { status: "manual", note: "x" },
      "R1.3": { status: "bogus" },
      "R1.4": null,
    };
    const s = summarizeCoverage(coverage);
    expect(s.total).toBe(4);
    expect(s.counts.unit).toBe(1);
    expect(s.counts.manual).toBe(1);
    expect(s.invalid).toBe(2);
  });

  it("defaults to the real manifest and reports no invalid entries", () => {
    const s = summarizeCoverage();
    expect(s.invalid).toBe(0);
    expect(s.total).toBe(Object.keys(REQUIREMENT_COVERAGE).length);
  });

  it("exposes the closed set of verification statuses", () => {
    expect(VERIFICATION_STATUSES).toEqual(["unit", "manual", "review", "gate", "deferred"]);
  });
});

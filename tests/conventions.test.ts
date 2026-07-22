// Requirement-level invariants that line/branch coverage cannot express (VS-58).
//
// A green 100% coverage report proves every line *ran*; it cannot see a documented
// behavior with no asserting test, a stale requirement, a dependency that crept in,
// or a pure module that quietly dropped out of the coverage gate. This file pins
// those, and runs the feature-coverage audit inside the normal `npm test` gate so a
// new requirement without a coverage decision fails CI.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
// @ts-expect-error — JS module, no types
import { collectDefinedRequirements, runCheck } from "../tools/check-features.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

describe("dependency allow-list", () => {
  it("ships exactly the approved runtime dependencies", () => {
    const pkg = readJson("package.json");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["domotion-svg", "fluent-ffmpeg", "kerfjs", "ollama"]);
  });
});

describe("feature / requirement coverage (the axis line coverage misses)", () => {
  const result = runCheck();

  it("every documented requirement has a coverage decision (nothing missing)", () => {
    expect(result.audit.missing).toEqual([]);
  });

  it("no manifest entry is stale (orphaned from the docs)", () => {
    expect(result.audit.orphaned).toEqual([]);
  });

  it("no requirement is marked 'unit' without an asserting test", () => {
    expect(result.audit.unverified).toEqual([]);
  });

  it("no manifest entry has an invalid verification status", () => {
    expect(result.audit.invalid).toEqual([]);
  });

  it("every test file named in the manifest exists on disk", () => {
    expect(result.unresolved).toEqual([]);
  });

  it("indexes a non-trivial number of requirements across multiple docs", () => {
    const { ids, perDoc } = collectDefinedRequirements();
    expect(ids.length).toBeGreaterThan(50);
    expect(Object.keys(perDoc).length).toBeGreaterThan(5);
    expect(existsSync(join(ROOT, "docs/manual-test-plan.md"))).toBe(true);
  });
});

describe("pure-module coverage gate", () => {
  const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  const included = [...config.matchAll(/"((?:src|tools)\/[^"]+)"/g)].map((m) => m[1]);

  it("lists only real files in coverage.include", () => {
    expect(included.length).toBeGreaterThan(0);
    for (const rel of included) expect(existsSync(join(ROOT, rel)), rel).toBe(true);
  });

  it("keeps the requirement-coverage core under the 100% gate", () => {
    expect(included).toContain("tools/requirement-coverage.mjs");
  });
});

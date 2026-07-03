import { describe, expect, it } from "vitest";
import {
  analyzerPrepPlan,
  // @ts-expect-error — JS module, no types
} from "../tools/launcher-plan.mjs";

// The launcher must NOT recompile when the npm package's prebuilt dist/ is present —
// recompiling needs the TS devDependencies npm omits for consumers, which is what made
// `tsc` fail with type errors for globally-installed users (VS-77).
describe("analyzerPrepPlan", () => {
  it("does nothing for an installed consumer: prebuilt dist, runtime deps, no toolchain", () => {
    // The VS-77 case — must NOT run `tsc` (no @types/*, no typescript for consumers).
    expect(analyzerPrepPlan({ hasDist: true, hasRuntimeDeps: true, hasToolchain: false })).toEqual({
      npmInstall: false,
      build: false,
    });
  });

  it("still rebuilds in a dev checkout (dist + toolchain present) to keep dist fresh", () => {
    expect(analyzerPrepPlan({ hasDist: true, hasRuntimeDeps: true, hasToolchain: true })).toEqual({
      npmInstall: false,
      build: true,
    });
  });

  it("never builds when dist is present but the toolchain is absent; installs missing runtime deps", () => {
    // committed/leftover dist, no node_modules, no toolchain → use dist, just get deps
    expect(analyzerPrepPlan({ hasDist: true, hasRuntimeDeps: false, hasToolchain: false })).toEqual({
      npmInstall: true,
      build: false,
    });
  });

  it("builds a fresh source checkout, installing the full toolchain first", () => {
    expect(analyzerPrepPlan({ hasDist: false, hasRuntimeDeps: false, hasToolchain: false })).toEqual({
      npmInstall: true,
      build: true,
    });
  });

  it("builds without reinstalling when deps + toolchain are present but dist is gone", () => {
    expect(analyzerPrepPlan({ hasDist: false, hasRuntimeDeps: true, hasToolchain: true })).toEqual({
      npmInstall: false,
      build: true,
    });
  });

  it("reinstalls before building when a build is needed but the toolchain is missing", () => {
    expect(analyzerPrepPlan({ hasDist: false, hasRuntimeDeps: true, hasToolchain: false })).toEqual({
      npmInstall: true,
      build: true,
    });
  });
});

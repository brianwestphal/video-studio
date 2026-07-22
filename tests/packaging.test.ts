import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the VS-8 regressions: (1) machine-specific absolute paths / the old
// project name leaking into shipped source, and (2) the promo-assets packaging
// shipping junk (generated SVGs, nested node_modules) or dropping the example
// sources. These are file-shape assertions, not unit logic, so they're excluded
// from the coverage `include` in vitest.config.ts.

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// Directories whose contents ship (or drive a release) and must stay portable.
const SHIPPED_SCRIPT_DIRS = ["bin", "src", "tools", "scripts"];
const PROMO = "promo-assets";

function filesIn(dir: string, exts: string[]): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => join(dir, f));
}

const scriptFiles = [
  ...SHIPPED_SCRIPT_DIRS.flatMap((d) => filesIn(d, [".ts", ".mjs", ".js", ".sh"])),
  ...filesIn(PROMO, [".mjs", ".sh"]),
];

describe("no machine-specific paths in shipped sources", () => {
  it.each(scriptFiles)("%s has no hardcoded /Users/ path", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    expect(text, `${rel} contains a hardcoded /Users/ path`).not.toMatch(/\/Users\//);
  });

  it.each(scriptFiles)("%s does not reference the old project name", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    expect(text, `${rel} references the old name 'video-scene-analyzer'`).not.toContain("video-scene-analyzer");
  });
});

describe("package.json files whitelist", () => {
  const files: string[] = pkg.files;

  it("ships the promo-assets example sources by glob", () => {
    expect(files).toContain("promo-assets/*.mjs");
    expect(files).toContain("promo-assets/*.sh");
  });

  it("does NOT ship the whole promo-assets dir (would drag in generated SVGs + nested node_modules)", () => {
    expect(files).not.toContain("promo-assets");
    expect(files).not.toContain("promo-assets/");
    expect(files.some((f) => f.endsWith(".svg"))).toBe(false);
  });

  it("ships README, CHANGELOG, and LICENSE", () => {
    for (const f of ["README.md", "CHANGELOG.md", "LICENSE"]) {
      expect(files).toContain(f);
    }
  });
});

describe("shipped example scripts are syntactically valid", () => {
  it("each promo-assets .mjs passes node --check", () => {
    for (const f of filesIn(PROMO, [".mjs"])) {
      expect(() => execFileSync("node", ["--check", join(ROOT, f)]), `${f} failed node --check`).not.toThrow();
    }
  });

  it("each promo-assets .sh passes bash -n", () => {
    for (const f of filesIn(PROMO, [".sh"])) {
      expect(() => execFileSync("bash", ["-n", join(ROOT, f)]), `${f} failed bash -n`).not.toThrow();
    }
  });
});

describe("kerf review client packaging", () => {
  const serverSource = readFileSync(join(ROOT, "tools/review-switches.mjs"), "utf8");

  it("serves only the compiled kerf bundle", () => {
    expect(serverSource).toContain('<script src="review-entry.js"></script>');
    expect(serverSource).not.toContain("legacy-review-client");
    expect(serverSource).not.toContain("function buildSeg(");
    expect(pkg.scripts["build:ui"]).toContain("ui/review-entry.tsx");
  });
});

describe("kerf desktop client packaging", () => {
  const desktopHtml = readFileSync(join(ROOT, "desktop/ui/index.html"), "utf8");
  const desktopSource = readFileSync(join(ROOT, "ui/desktop-app.tsx"), "utf8");

  it("ships the generated Kerf bundle without the vanilla DOM renderer", () => {
    expect(desktopHtml).toContain('<div id="app">Loading…</div>');
    expect(desktopHtml).toContain('<script src="app.js"></script>');
    expect(desktopHtml).not.toContain("rail-stages");
    expect(desktopSource).not.toContain("innerHTML");
    expect(pkg.scripts["build:desktop-ui"]).toContain("ui/desktop-entry.tsx");
    expect(pkg.scripts["build:desktop-ui"]).toContain("desktop/ui/app.js");
  });
});

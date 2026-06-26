import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  block,
  buildPage,
  buildSpecs,
  iconImg,
  IN_STEPS,
  namespaceSvgIds,
  OUT_STEPS,
  parseArgs,
  wrapPos,
} from "../tools/caption-format.mjs";

describe("parseArgs", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills defaults and requires text + out", () => {
    const o = parseArgs(["--text", "Hello", "--out", "cap.svg"]);
    expect(o).toMatchObject({
      text: ["Hello"],
      out: "cap.svg",
      style: "pill",
      position: "lower-third",
      duration: 2.0,
      fps: 24,
      width: 1920,
      height: 1080,
      accent: "#ff5a00",
    });
  });

  it("accumulates repeated --text into multiple lines", () => {
    const o = parseArgs(["--text", "a", "--text", "b", "--out", "x.svg"]);
    expect(o.text).toEqual(["a", "b"]);
  });

  it("parses every option", () => {
    const o = parseArgs([
      "--text", "T",
      "--style", "cta",
      "--position", "center",
      "--duration", "3.5",
      "--fps", "30",
      "--width", "1080",
      "--height", "1920",
      "--accent", "#abc",
      "--icon", "i.svg",
      "--font", "Georgia",
      "--size", "80",
      "--out", "o.svg",
    ]);
    expect(o).toMatchObject({
      style: "cta",
      position: "center",
      duration: 3.5,
      fps: 30,
      width: 1080,
      height: 1920,
      accent: "#abc",
      icon: "i.svg",
      font: "Georgia",
      size: 80,
      out: "o.svg",
    });
  });

  it("prints help and exits 0 on --help", () => {
    expect(() => parseArgs(["--help"], "HELP TEXT")).toThrow("exit:0");
    expect(logSpy).toHaveBeenCalledWith("HELP TEXT");
  });

  it("exits 2 on an unknown option", () => {
    expect(() => parseArgs(["--nope"])).toThrow("exit:2");
    expect(errSpy).toHaveBeenCalledWith("Unknown option: --nope");
  });

  it("exits 2 when no --text is given", () => {
    expect(() => parseArgs(["--out", "x.svg"])).toThrow("exit:2");
  });

  it("exits 2 when no --out is given", () => {
    expect(() => parseArgs(["--text", "hi"])).toThrow("exit:2");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe("namespaceSvgIds", () => {
  it("rewrites id, url(#…) and (xlink:)href references with the uid prefix", () => {
    const svg = '<svg><linearGradient id="grad"/><rect fill="url(#grad)"/><use href="#grad"/><use xlink:href="#grad"/></svg>';
    const out = namespaceSvgIds(svg, "ic");
    expect(out).toContain('id="ic_grad"');
    expect(out).toContain("url(#ic_grad)");
    expect(out).toContain('href="#ic_grad"');
    expect(out).toContain('xlink:href="#ic_grad"');
    expect(out).not.toMatch(/#grad"/);
  });

  it("returns the SVG unchanged when there are no ids", () => {
    const svg = "<svg><rect/></svg>";
    expect(namespaceSvgIds(svg, "ic")).toBe(svg);
  });
});

describe("iconImg", () => {
  it("embeds a namespaced SVG icon as a base64 data-URI <img>", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-icon-"));
    const file = join(dir, "icon.svg");
    writeFileSync(file, '<svg><linearGradient id="g"/><rect fill="url(#g)"/></svg>');

    const html = iconImg(file, 60);
    expect(html).toContain('width="60" height="60"');
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain(`border-radius:${Math.round(60 * 0.2)}px`);

    // Round-trip the embedded payload to confirm ids were namespaced.
    const b64 = /base64,([^"]+)/.exec(html)![1]!;
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    expect(decoded).toContain('id="ic_g"');
  });
});

describe("block", () => {
  it("renders the plain style as centered stacked spans", () => {
    const html = block({ style: "plain", text: ["Title", "Subtitle"], font: "Arial" });
    expect(html).toContain("flex-direction:column");
    expect(html).toContain("Title");
    expect(html).toContain("Subtitle");
  });

  it("renders the cta style with a pill button plus monospace sublines", () => {
    const html = block({ style: "cta", text: ["Watch →", "example.com"], font: "Arial", accent: "#f00" });
    expect(html).toContain("Watch →");
    expect(html).toContain("Menlo,Monaco,monospace");
    expect(html).toContain("example.com");
  });

  it("renders the cta style with no sublines when only one text line is given", () => {
    const html = block({ style: "cta", text: ["Go"], font: "Arial", accent: "#f00" });
    expect(html).toContain("Go");
    expect(html).not.toContain("monospace");
  });

  it("renders the default pill style", () => {
    const html = block({ style: "pill", text: ["Heading", "sub"], font: "Arial", accent: "#0a0" });
    expect(html).toContain("border-left:6px solid #0a0");
    expect(html).toContain("Heading");
  });

  it("uses the custom --size when provided", () => {
    const html = block({ style: "pill", text: ["x"], font: "Arial", accent: "#000", size: 99 });
    expect(html).toContain("font-size:99px");
  });

  it("embeds an icon at the pill/72px size when --icon is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-block-"));
    const file = join(dir, "i.svg");
    writeFileSync(file, "<svg><rect/></svg>");
    const html = block({ style: "pill", text: ["x"], font: "Arial", accent: "#000", icon: file });
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain('width="72" height="72"');
  });

  it("embeds an icon at the cta/60px size when --icon is set on a cta", () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-block-cta-"));
    const file = join(dir, "i.svg");
    writeFileSync(file, "<svg><rect/></svg>");
    const html = block({ style: "cta", text: ["Go"], font: "Arial", accent: "#000", icon: file });
    expect(html).toContain('width="60" height="60"');
  });
});

describe("wrapPos", () => {
  const o = { position: "center", height: 1080 };

  it("centers vertically for the center position", () => {
    expect(wrapPos("X", { ...o, position: "center" }, 1, 0)).toContain("align-items:center");
  });

  it("pins to the top for upper-third", () => {
    const html = wrapPos("X", { ...o, position: "upper-third" }, 1, 0);
    expect(html).toContain("align-items:flex-start");
    expect(html).toContain(`top:${Math.round(1080 * 0.14)}px`);
  });

  it("pins to the bottom for lower-third (default)", () => {
    const html = wrapPos("X", { ...o, position: "lower-third" }, 0.5, -3);
    expect(html).toContain("align-items:flex-end");
    expect(html).toContain("opacity:0.5");
    expect(html).toContain("translateY(-3px)");
  });
});

describe("buildPage", () => {
  it("produces an HTML doc sized to the canvas with the block embedded", () => {
    const o = { style: "plain", text: ["Hi"], font: "Arial", width: 1280, height: 720, position: "center" };
    const html = buildPage(o, 1, 0);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("width:1280px");
    expect(html).toContain("height:720px");
    expect(html).toContain("Hi");
  });
});

describe("buildSpecs", () => {
  it("emits fade-in keyframes, a single hold, then fade-out keyframes", () => {
    const specs = buildSpecs({ fps: 24, duration: 2.0 });
    expect(specs).toHaveLength(IN_STEPS.length + 1 + OUT_STEPS.length);

    const hold = specs[IN_STEPS.length]!;
    expect(hold).toMatchObject({ op: 1, ty: 0 });
    // 2.0s = 2000ms, minus 10 frames (10 * 1000/24 ≈ 416.7ms) → ~1583ms hold.
    expect(hold.dur).toBeCloseTo(2000 - 10 * (1000 / 24), 1);

    expect(specs[0]).toMatchObject({ op: IN_STEPS[0]![0], ty: IN_STEPS[0]![1] });
    expect(specs.at(-1)).toMatchObject({ op: OUT_STEPS.at(-1)![0], ty: OUT_STEPS.at(-1)![1] });
  });

  it("clamps the hold to at least one frame for very short durations", () => {
    const specs = buildSpecs({ fps: 24, duration: 0.1 });
    const hold = specs[IN_STEPS.length]!;
    expect(hold.dur).toBeCloseTo(1000 / 24, 5);
  });
});

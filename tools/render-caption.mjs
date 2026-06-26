#!/usr/bin/env node
/**
 * render-caption — generate an animated caption / lower-third / CTA as a
 * transparent animated SVG (domotion-svg). Render it to alpha video with the
 * svg-to-video bin for compositing.
 *
 * Usage:
 *   render-caption --text "Your own private Kanban + List" --out cap.svg
 *   render-caption --style cta --text "Watch the full demo →" --text "{{URL}}" --out cta.svg
 *
 * Options:
 *   --text <s>        Caption line. Repeat for multiple lines.
 *   --style <s>       pill (default) | plain | cta
 *   --position <p>    lower-third (default) | center | upper-third
 *   --duration <s>    Total seconds incl. fade in/out (default 2.0)
 *   --fps <n>         Frame rate to align to (default 24)
 *   --width/--height  Canvas (default 1920x1080)
 *   --accent <css>    Accent color (default #ff5a00)
 *   --icon <path>     SVG icon to chip on the left (pill/cta)
 *   --font <css>      Font family (default Avenir/Helvetica)
 *   --size <px>       Primary text size (style-dependent default)
 *   --out <path>      Output .svg (required)
 *
 * The pure caption/argument logic lives in ./caption-format.mjs (unit-tested);
 * this file owns the headless-Chromium rendering pipeline.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { captureElementTree, embedRemoteImages, elementTreeToSvgInner, generateAnimatedSvg, optimizeSvg } from "domotion-svg";
import { buildPage, buildSpecs, parseArgs } from "./caption-format.mjs";

const HELP = [
  "render-caption — generate an animated caption / lower-third / CTA as a",
  "transparent animated SVG (domotion-svg).",
  "",
  "Usage:",
  '  render-caption --text "Your caption" --out cap.svg',
  '  render-caption --style cta --text "Watch the full demo →" --text "{{URL}}" --out cta.svg',
  "",
  "Options:",
  "  --text <s>        Caption line. Repeat for multiple lines.",
  "  --style <s>       pill (default) | plain | cta",
  "  --position <p>    lower-third (default) | center | upper-third",
  "  --duration <s>    Total seconds incl. fade in/out (default 2.0)",
  "  --fps <n>         Frame rate to align to (default 24)",
  "  --width/--height  Canvas (default 1920x1080)",
  "  --accent <css>    Accent color (default #ff5a00)",
  "  --icon <path>     SVG icon to chip on the left (pill/cta)",
  "  --font <css>      Font family (default Avenir/Helvetica)",
  "  --size <px>       Primary text size (style-dependent default)",
  "  --out <path>      Output .svg (required)",
].join("\n");

async function main() {
  const o = parseArgs(process.argv.slice(2), HELP);
  const specs = buildSpecs(o);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: o.width, height: o.height } });
  const pg = await ctx.newPage();
  const cache = new Map();
  const frames = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const key = `${s.op}_${s.ty}`;
    if (!cache.has(key)) {
      const tmp = `${process.env.TMPDIR || "/tmp"}/render-caption-${process.pid}-${i}.html`;
      writeFileSync(tmp, buildPage(o, s.op, s.ty));
      await pg.goto(`file://${tmp}`);
      await pg.waitForTimeout(80);
      const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: o.width, height: o.height });
      await embedRemoteImages(tree);
      cache.set(key, elementTreeToSvgInner(tree, o.width, o.height, `c${i}-`));
    }
    frames.push({ svgContent: cache.get(key), duration: s.dur, transition: { type: "cut", duration: 0 } });
  }
  await browser.close();

  let svg = generateAnimatedSvg({ width: o.width, height: o.height, frames });
  svg = optimizeSvg(svg);
  writeFileSync(o.out, svg);
  console.log(`wrote ${o.out} (${(svg.length / 1024).toFixed(1)} KB, ${o.duration}s @ ${o.fps}fps, style=${o.style}, pos=${o.position})`);
}

// Only run the browser pipeline when invoked directly (not when imported in tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e?.stack || e); process.exit(1); });
}

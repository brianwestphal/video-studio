/**
 * HotSheet teaser caption overlays (segments 2, 3, 6), built with domotion-svg.
 *
 * Each is a 1920x1080 TRANSPARENT animated SVG: a quick slide+fade IN, a solid
 * hold, then a fade OUT — total duration baked to the exact 24fps frame count
 * requested per segment. Lower-third placement so it clears a centered logo.
 *
 * Frame stepping: every IN/OUT step and the loop are exactly one 24fps frame
 * (1000/24 ms), so the overlay lands judder-free on a 24fps timeline. The hold
 * is a single long non-final frame (stays solid; the animator only fades the
 * LAST frame on loop, which here is the opacity-0 OUT tail → invisible).
 *
 * Swap the placeholder link by editing FULL_VIDEO_URL below.
 *
 * Run (Chromium needs the OS sandbox relaxed):
 *   node promo-assets/build-hotsheet-captions.mjs
 */
import { createRequire } from "node:module";
const require = createRequire("/Users/westphal/Documents/domotion/package.json");
const { chromium } = require("@playwright/test");
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

const D = await import("/Users/westphal/Documents/domotion/dist/index.js");
const { captureElementTree, embedRemoteImages, elementTreeToSvgInner, generateAnimatedSvg, optimizeSvg } = D;

const ICONS = process.env.HOME + "/Desktop/icons-temp";
const OUT_DIR = "/Users/westphal/Documents/video-scene-analyzer/promo-assets";
const TMP = "/tmp/claude";
const WIDTH = 1920;
const HEIGHT = 1080;
const FU = 1000 / 24; // one frame at 24fps

// ↓↓↓ replace with the real link when you have it ↓↓↓
const FULL_VIDEO_URL = "{{FULL_VIDEO_URL}}";

// ── icon helper (namespace ids so embedded data-URIs don't collide) ──────────
const dataUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
function readIcon(name) {
  const ns = name.replace(/[^a-z0-9]/gi, "");
  return readFileSync(`${ICONS}/${name}.svg`, "utf8")
    .replaceAll("linearGradient-2", `${ns}lg`)
    .replaceAll("path-1", `${ns}p1`);
}
const chip = (size) =>
  `<img src="${dataUri(readIcon("hotsheet-icon"))}" width="${size}" height="${size}" `
  + `style="display:block;border-radius:${Math.round(size * 0.22)}px;flex:none;`
  + `filter:drop-shadow(0 4px 12px rgba(0,0,0,.4));"/>`;

// ── caption content blocks ──────────────────────────────────────────────────
const SANS = "'Avenir Next','Helvetica Neue',Arial,sans-serif";

function pill(text) {
  return `<div style="display:inline-flex;align-items:center;gap:26px;padding:26px 48px;`
    + `background:rgba(11,13,17,0.82);border:1px solid rgba(255,255,255,0.10);border-radius:26px;`
    + `box-shadow:0 14px 48px rgba(0,0,0,.5);">`
    + chip(72)
    + `<span style="font-family:${SANS};font-weight:600;font-size:62px;color:#fff;`
    + `letter-spacing:-0.5px;line-height:1;white-space:nowrap;">${text}</span>`
    + `</div>`;
}

function ctaBlock(url) {
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center;">`
    // CTA button pill (fire gradient)
    + `<div style="display:inline-flex;align-items:center;gap:18px;padding:22px 46px;border-radius:999px;`
    + `background:linear-gradient(180deg,#ffb300,#ff5a00);box-shadow:0 12px 34px rgba(255,90,0,.5);">`
    + chip(60)
    + `<span style="font-family:${SANS};font-weight:800;font-size:54px;color:#fff;letter-spacing:-0.3px;line-height:1;">`
    + `Watch the full demo →</span></div>`
    // URL line (mono, placeholder)
    + `<div style="font-family:Menlo,Monaco,monospace;font-size:34px;color:rgba(255,255,255,.82);`
    + `letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,.6);">${url}</div>`
    + `</div>`;
}

// ── caption configs ─────────────────────────────────────────────────────────
const CAPTIONS = [
  { name: "caption-seg2", frames: 42, anchorBottom: 150, content: pill("Your own private Kanban + List") },
  { name: "caption-seg3", frames: 48, anchorBottom: 150, content: pill("…and Claude does the work") },
  { name: "caption-seg6", frames: 43, anchorBottom: 120, content: ctaBlock(FULL_VIDEO_URL) },
];

// IN: slide up + fade in; OUT: fade out + drift up. Each step = 1 frame.
const IN_STEPS = [[0.12, 26], [0.4, 16], [0.68, 9], [0.88, 4], [1, 0]];
const OUT_STEPS = [[0.8, -3], [0.58, -6], [0.36, -9], [0.16, -12], [0, -15]];

function buildPage(content, opacity, ty, anchorBottom) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { background: transparent; }
    body { width:${WIDTH}px; height:${HEIGHT}px; overflow:hidden; font-family:sans-serif; }
    .stage { position:relative; width:${WIDTH}px; height:${HEIGHT}px; }
    .wrap { position:absolute; left:0; right:0; bottom:${anchorBottom}px;
            display:flex; justify-content:center;
            opacity:${opacity}; transform:translateY(${ty}px); }
  </style></head><body><div class="stage"><div class="wrap">${content}</div></div></body></html>`;
}

async function buildCaption(pg, cfg) {
  // frame plan: 5 IN steps (1f each) + 1 long hold + 5 OUT steps (1f each)
  const holdMs = (cfg.frames - 10) * FU;
  const specs = [
    ...IN_STEPS.map(([o, ty]) => ({ o, ty, dur: FU })),
    { o: 1, ty: 0, dur: holdMs },
    ...OUT_STEPS.map(([o, ty]) => ({ o, ty, dur: FU })),
  ];

  // capture each distinct (opacity,ty) once
  const cache = new Map();
  const frames = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const key = `${s.o}_${s.ty}`;
    if (!cache.has(key)) {
      const tmp = `${TMP}/${cfg.name}-tmp-${i}.html`;
      writeFileSync(tmp, buildPage(cfg.content, s.o, s.ty, cfg.anchorBottom));
      await pg.goto(`file://${tmp}`);
      await pg.waitForTimeout(80);
      const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      await embedRemoteImages(tree);
      cache.set(key, elementTreeToSvgInner(tree, WIDTH, HEIGHT, `c${i}-`));
      rmSync(tmp, { force: true });
    }
    frames.push({ svgContent: cache.get(key), duration: s.dur, transition: { type: "cut", duration: 0 } });
  }

  let svg = generateAnimatedSvg({ width: WIDTH, height: HEIGHT, frames });
  svg = optimizeSvg(svg);
  const out = `${OUT_DIR}/${cfg.name}.svg`;
  writeFileSync(out, svg);
  const total = specs.reduce((a, s) => a + s.dur, 0);
  console.log(`Generated: ${out} (${(svg.length / 1024).toFixed(1)} KB, ${cfg.frames} frames / ${(total / 1000).toFixed(3)}s)`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const pg = await context.newPage();
  for (const cfg of CAPTIONS) await buildCaption(pg, cfg);
  await browser.close();
}

await main();

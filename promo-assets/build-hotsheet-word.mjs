/**
 * HotSheet animated wordmark for promo-video end cards.
 *
 * Fixed vertical lockup, transparent background:
 *   • LOGO  — centered, large, absolutely positioned at a FIXED y so it never
 *     moves between segments. Cycles through ALL ten icon variants.
 *   • TITLE — "HotSheet" in rapid-fire 90s-retro variants (varied caps + style),
 *     centered in a fixed-height band BELOW the logo, so changing the text size
 *     never reflows / shifts the logo.
 * The whole logo+title block is roughly vertically centered in the canvas.
 *
 * Built with domotion-svg like examples/domotion-word-demo.ts: each variant is a
 * transparent HTML page captured to one SVG frame, stitched into a looping SVG.
 * Icons are embedded as <img> data-URIs (each its own SVG document) to avoid the
 * shared-id collision in the icon set (linearGradient-2 / path-1).
 *
 * Run (Chromium needs the OS sandbox relaxed):
 *   node promo-assets/build-hotsheet-word.mjs
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
const OUTPUT = `${OUT_DIR}/hotsheet-word.svg`;

// ── fixed layout geometry (this is what keeps the logo from moving) ──────────
// 16:9 1920x1080 so it drops onto a 1080p timeline 1:1; the stacked lockup is
// centered with transparent sides.
const WIDTH = 1920;
const HEIGHT = 1080;
const ICON_SIZE = 400;       // logo: large
const GAP = 44;
const TITLE_BAND_H = 230;    // fixed band; text is centered within it
const BLOCK_H = ICON_SIZE + GAP + TITLE_BAND_H;        // 674
const LOGO_TOP = Math.round((HEIGHT - BLOCK_H) / 2);   // 203 — fixed logo y
const TITLE_TOP = LOGO_TOP + ICON_SIZE + GAP;          // 647

// All ten provided logo variants, in order.
const ICON_SET = [
  "hotsheet-icon",
  "hotsheet-icon-variant-1", "hotsheet-icon-variant-2", "hotsheet-icon-variant-3",
  "hotsheet-icon-variant-4", "hotsheet-icon-variant-5", "hotsheet-icon-variant-6",
  "hotsheet-icon-variant-7", "hotsheet-icon-variant-8", "hotsheet-icon-variant-9",
];

// ── helpers ──────────────────────────────────────────────────────────────
const dataUri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");

// Every icon reuses the same internal ids (linearGradient-2 / path-1). Packed
// into one SVG, Chromium leaks one gradient across all embedded icon documents
// and they all render the same color. Namespace the ids per variant to isolate.
function readIcon(name) {
  const ns = name.replace(/[^a-z0-9]/gi, "");
  return readFileSync(`${ICONS}/${name}.svg`, "utf8")
    .replaceAll("linearGradient-2", `${ns}lg`)
    .replaceAll("path-1", `${ns}p1`);
}

function iconImg(name, size) {
  return `<img src="${dataUri(readIcon(name))}" width="${size}" height="${size}" `
    + `style="display:block;border-radius:${Math.round(size * 0.22)}px;`
    + `filter:drop-shadow(0 ${Math.round(size * 0.03)}px ${Math.round(size * 0.07)}px rgba(0,0,0,.38));"/>`;
}

const BASE = "vertical-align:baseline;display:inline-block;";
function word(text, o) {
  return `<span style="font-family:${o.font};font-size:${o.size}px;font-weight:${o.weight ?? 900};`
    + `${o.style ? `font-style:${o.style};` : ""}letter-spacing:${o.ls ?? 0}px;color:${o.color};`
    + `${o.glow ? `text-shadow:${o.glow};` : ""}${o.ml ? `margin-left:${o.ml}px;` : ""}`
    + `${o.mr ? `margin-right:${o.mr}px;` : ""}${o.extra ?? ""}${BASE}">${text}</span>`;
}
function grad(text, o) {
  return `<span style="font-family:${o.font};font-size:${o.size}px;font-weight:${o.weight ?? 900};`
    + `${o.style ? `font-style:${o.style};` : ""}letter-spacing:${o.ls ?? 0}px;background:${o.gradient};`
    + `-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;`
    + `${o.extra ?? ""}${BASE}">${text}</span>`;
}

// ── palette (glow radii / hard-shadow offsets scaled up for ~150px type) ────
const FIRE_GRAD = "linear-gradient(180deg,#fff3a0 0%,#ffb300 30%,#ff6a00 65%,#ff0000 100%)";
const FIRE = "0 0 14px #ff6a00,0 0 34px #ff2a00,0 0 60px #ff0000";
const AMBER = "0 0 18px #ffb300,0 0 40px #ff7b00";
const CYAN = "0 0 14px #00ffff,0 0 30px #00ffff";
const GREEN = "0 0 14px #39ff14,0 0 34px #39ff14";
const YELLOW = "0 0 20px #fff700,0 0 44px #ff8c00";

const FAST = 125; // 3 frames @ 24fps (exact)

// Title-style factories (each returns the inner markup for the title band).
const TITLES = [
  () => grad("HotSheet", { font: "Impact,'Arial Black',sans-serif", size: 160, ls: -3, gradient: FIRE_GRAD, extra: "text-shadow:0 0 38px rgba(255,80,0,.6);" }),
  () => grad("HOTSHEET", { font: "'Arial Black',Arial,sans-serif", size: 138, ls: -2, gradient: "linear-gradient(180deg,#ffffff 0%,#b9c6d6 45%,#5b6b7a 55%,#dfe9f2 100%)", extra: "text-shadow:0 0 18px #00e5ff,0 0 42px #0091ff;" }),
  () => grad("hotsheet", { font: "Futura,'Avenir Next',sans-serif", size: 160, ls: 3, gradient: "linear-gradient(90deg,#ff10f0,#ff8c00,#fff700,#39ff14,#00ffff)" }),
  () => word("hot", { font: "'Courier New',monospace", size: 62, weight: 700, color: "#ff6a00", glow: AMBER, mr: 14 }) + word("SHEET", { font: "Impact,sans-serif", size: 180, ls: -7, color: "#00ffff", glow: "-9px 0 0 #ff10f0,9px 0 0 #fff700" }),
  () => word("Ho", { font: "'American Typewriter',Courier,monospace", size: 146, weight: 700, color: "#05d9e8", glow: "5px 5px 0 #003b33" }) + word("Ts", { font: "'American Typewriter',Courier,monospace", size: 146, weight: 700, color: "#ff2a6d", glow: "5px 5px 0 #3b0014" }) + word("He", { font: "'American Typewriter',Courier,monospace", size: 146, weight: 700, color: "#05d9e8", glow: "5px 5px 0 #003b33" }) + word("Et", { font: "'American Typewriter',Courier,monospace", size: 146, weight: 700, color: "#ff2a6d", glow: "5px 5px 0 #3b0014" }),
  () => word("HotSheet", { font: "'Brush Script MT','Snell Roundhand',cursive", size: 168, weight: 400, style: "italic", color: "#fff700", glow: YELLOW }),
  () => grad("HOTSHEET", { font: "'Arial Black',sans-serif", size: 134, ls: -2, gradient: "linear-gradient(180deg,#00ffff,#ff00ff)", extra: "text-shadow:0 0 32px rgba(255,0,255,.5);" }),
  () => word("hotsheet", { font: "Menlo,Monaco,monospace", size: 130, weight: 700, ls: 5, color: "#39ff14", glow: GREEN }),
  () => word("Hotsheet", { font: "Didot,'Bodoni 72',serif", size: 160, weight: 400, ls: 2, color: "#fde7ff", glow: "0 0 18px #ff7bd5,0 0 40px #d000ff" }),
  () => grad("HOTSHEET", { font: "Copperplate,'Copperplate Gothic Light',serif", size: 114, weight: 700, ls: 5, gradient: "linear-gradient(180deg,#fff1a8,#ffcf40 45%,#ff8c00)", extra: "text-shadow:3px 3px 0 #7a3b00,5px 5px 0 rgba(0,0,0,.4);" }),
  () => word("hotSheet", { font: "'Gill Sans','Helvetica Neue',sans-serif", size: 152, weight: 600, ls: 2, color: "#fff", glow: FIRE }),
  () => word("HotSheet", { font: "'Avenir Next',Futura,sans-serif", size: 150, weight: 800, ls: -3, color: "#fff", glow: "5px 5px 0 #ff10f0,10px 10px 0 #00ffff" }),
  () => grad("HOT", { font: "Impact,sans-serif", size: 166, ls: -3, gradient: FIRE_GRAD }) + word("sheet", { font: "Impact,sans-serif", size: 166, ls: -3, color: "#00ffff", glow: CYAN, ml: 8 }),
  () => word("hotsheet", { font: "'Helvetica Neue',Arial,sans-serif", size: 122, weight: 200, ls: 24, color: "#aef6ff", glow: "0 0 10px #00ffff,0 0 28px #00cfff" }),
  () => word("HoTSheeT", { font: "'Marker Felt','Comic Sans MS',cursive", size: 142, weight: 700, color: "#fff700", glow: "3px 3px 0 #ff10f0,7px 7px 0 #ff6a00,11px 11px 0 rgba(0,0,0,.4)" }),
  () => word("HOTSHEET", { font: "Impact,'Arial Black',sans-serif", size: 140, ls: -3, color: "#ff2bd6", glow: "3px 3px 0 #00d9ff,7px 7px 0 #00d9ff,11px 11px 0 #007a8c,15px 15px 0 #004a55" }),
];

// One rapid frame per title style; logo cycles through all ten variants.
const VARIANTS = TITLES.map((t, i) => ({
  duration: FAST,
  icon: ICON_SET[i % ICON_SET.length],
  title: t(),
}));

// FINAL — clean held lockup (the resolved logo): base paper icon + fire wordmark.
// The animator fades the LAST frame out over its full duration to loop back to
// frame 0, so a single long hold visibly fades to black. Build the hold from
// several SHORT identical frames instead — the logo stays solid, and only the
// very last short copy dips briefly at the loop point.
const FINAL_TITLE = grad("HotSheet", { font: "'Avenir Next',Futura,'Helvetica Neue',sans-serif", size: 168, weight: 800, ls: -3, gradient: FIRE_GRAD, extra: "text-shadow:0 0 2px #fff,0 4px 20px rgba(0,0,0,.25);" });
for (let k = 0; k < 8; k++) {
  VARIANTS.push({ duration: 250, icon: "hotsheet-icon", title: FINAL_TITLE });
}

function buildPage(v) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { background: transparent; }
    body { width:${WIDTH}px; height:${HEIGHT}px; overflow:hidden; font-family:sans-serif; }
    .stage { position:relative; width:${WIDTH}px; height:${HEIGHT}px; }
    .logo  { position:absolute; left:50%; top:${LOGO_TOP}px; transform:translateX(-50%); }
    .title { position:absolute; left:0; top:${TITLE_TOP}px; width:${WIDTH}px; height:${TITLE_BAND_H}px;
             display:flex; align-items:center; justify-content:center; white-space:nowrap; line-height:1; }
  </style></head><body><div class="stage">
    <div class="logo">${iconImg(v.icon, ICON_SIZE)}</div>
    <div class="title">${v.title}</div>
  </div></body></html>`;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const pg = await context.newPage();

  const frames = [];
  for (let i = 0; i < VARIANTS.length; i++) {
    const tmp = `${TMP}/hotsheet-word-tmp-${i}.html`;
    writeFileSync(tmp, buildPage(VARIANTS[i]));
    await pg.goto(`file://${tmp}`);
    await pg.waitForTimeout(120);
    const tree = await captureElementTree(pg, "body", { x: 0, y: 0, width: WIDTH, height: HEIGHT });
    await embedRemoteImages(tree);
    frames.push({
      svgContent: elementTreeToSvgInner(tree, WIDTH, HEIGHT, `v${i}-`),
      duration: VARIANTS[i].duration,
      transition: { type: "cut", duration: 0 },
    });
    rmSync(tmp, { force: true });
  }
  await browser.close();

  let svg = generateAnimatedSvg({ width: WIDTH, height: HEIGHT, frames });
  svg = optimizeSvg(svg);
  writeFileSync(OUTPUT, svg);
  console.log(`Generated: ${OUTPUT} (${(svg.length / 1024).toFixed(1)} KB, ${VARIANTS.length} variants)`);
}

await main();

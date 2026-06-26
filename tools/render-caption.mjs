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
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { captureElementTree, embedRemoteImages, elementTreeToSvgInner, generateAnimatedSvg, optimizeSvg } from "domotion-svg";

// ── args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { text: [], style: "pill", position: "lower-third", duration: 2.0, fps: 24, width: 1920, height: 1080, accent: "#ff5a00", font: "'Avenir Next','Helvetica Neue',Arial,sans-serif" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--help" || a === "-h") { console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 26).map((l) => l.replace(/^ \*\s?/, "")).join("\n")); process.exit(0); }
    else if (a === "--text") o.text.push(next());
    else if (a === "--style") o.style = next();
    else if (a === "--position") o.position = next();
    else if (a === "--duration") o.duration = parseFloat(next());
    else if (a === "--fps") o.fps = parseInt(next(), 10);
    else if (a === "--width") o.width = parseInt(next(), 10);
    else if (a === "--height") o.height = parseInt(next(), 10);
    else if (a === "--accent") o.accent = next();
    else if (a === "--icon") o.icon = next();
    else if (a === "--font") o.font = next();
    else if (a === "--size") o.size = parseInt(next(), 10);
    else if (a === "--out") o.out = next();
    else { console.error(`Unknown option: ${a}`); process.exit(2); }
  }
  if (!o.text.length) { console.error("Error: at least one --text is required."); process.exit(2); }
  if (!o.out) { console.error("Error: --out is required."); process.exit(2); }
  return o;
}

// Namespace ALL ids in an embedded SVG so multiple icons can't collide.
function namespaceSvgIds(svg, uid) {
  const ids = [...new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  for (const id of ids) {
    const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    svg = svg.replace(new RegExp(`id="${e}"`, "g"), `id="${uid}_${id}"`)
      .replace(new RegExp(`url\\(#${e}\\)`, "g"), `url(#${uid}_${id})`)
      .replace(new RegExp(`((?:xlink:)?href)="#${e}"`, "g"), `$1="#${uid}_${id}"`);
  }
  return svg;
}
function iconImg(path, size) {
  let svg = namespaceSvgIds(readFileSync(path, "utf8"), "ic");
  const uri = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
  return `<img src="${uri}" width="${size}" height="${size}" style="display:block;flex:none;border-radius:${Math.round(size * 0.2)}px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.4));"/>`;
}

// ── content blocks ────────────────────────────────────────────────────────
function block(o) {
  const icon = o.icon ? iconImg(o.icon, o.style === "cta" ? 60 : 72) : "";
  const size = o.size ?? (o.style === "cta" ? 54 : 60);
  if (o.style === "plain") {
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;">` +
      o.text.map((t, i) => `<span style="font-family:${o.font};font-weight:${i ? 500 : 700};font-size:${i ? Math.round(size * 0.6) : size}px;color:#fff;text-shadow:0 3px 14px rgba(0,0,0,.7),0 0 2px rgba(0,0,0,.8);letter-spacing:-0.3px;">${t}</span>`).join("") +
      `</div>`;
  }
  if (o.style === "cta") {
    const [first, ...rest] = o.text;
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center;">` +
      `<div style="display:inline-flex;align-items:center;gap:18px;padding:22px 46px;border-radius:999px;background:linear-gradient(180deg,${o.accent}cc,${o.accent});box-shadow:0 12px 34px ${o.accent}80;">` +
      icon + `<span style="font-family:${o.font};font-weight:800;font-size:${size}px;color:#fff;letter-spacing:-0.3px;line-height:1;">${first}</span></div>` +
      rest.map((t) => `<span style="font-family:Menlo,Monaco,monospace;font-size:${Math.round(size * 0.6)}px;color:rgba(255,255,255,.85);letter-spacing:1px;text-shadow:0 2px 8px rgba(0,0,0,.6);">${t}</span>`).join("") +
      `</div>`;
  }
  // pill
  return `<div style="display:inline-flex;align-items:center;gap:26px;padding:26px 48px;background:rgba(11,13,17,0.82);border:1px solid rgba(255,255,255,0.10);border-left:6px solid ${o.accent};border-radius:26px;box-shadow:0 14px 48px rgba(0,0,0,.5);">` +
    icon +
    `<div style="display:flex;flex-direction:column;gap:6px;">` +
    o.text.map((t, i) => `<span style="font-family:${o.font};font-weight:${i ? 500 : 600};font-size:${i ? Math.round(size * 0.62) : size}px;color:#fff;letter-spacing:-0.5px;line-height:1.05;white-space:nowrap;">${t}</span>`).join("") +
    `</div></div>`;
}

function wrapPos(inner, o, opacity, ty) {
  const pos = o.position === "center"
    ? `top:0;bottom:0;align-items:center;`
    : o.position === "upper-third"
      ? `top:${Math.round(o.height * 0.14)}px;align-items:flex-start;`
      : `bottom:${Math.round(o.height * 0.11)}px;align-items:flex-end;`;
  return `<div style="position:absolute;left:0;right:0;${pos}display:flex;justify-content:center;opacity:${opacity};transform:translateY(${ty}px);">${inner}</div>`;
}
function buildPage(o, opacity, ty) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box} html,body{background:transparent}
    body{width:${o.width}px;height:${o.height}px;overflow:hidden;font-family:sans-serif}
    .stage{position:relative;width:${o.width}px;height:${o.height}px}
  </style></head><body><div class="stage">${wrapPos(block(o), o, opacity, ty)}</div></body></html>`;
}

const IN_STEPS = [[0.12, 26], [0.4, 16], [0.68, 9], [0.88, 4], [1, 0]];
const OUT_STEPS = [[0.8, -3], [0.58, -6], [0.36, -9], [0.16, -12], [0, -15]];

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const FU = 1000 / o.fps;
  const holdMs = Math.max(FU, o.duration * 1000 - 10 * FU); // single long hold; OUT's last frame (opacity 0) absorbs the loop fade
  const specs = [
    ...IN_STEPS.map(([op, ty]) => ({ op, ty, dur: FU })),
    { op: 1, ty: 0, dur: holdMs },
    ...OUT_STEPS.map(([op, ty]) => ({ op, ty, dur: FU })),
  ];

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

main().catch((e) => { console.error(e?.stack || e); process.exit(1); });

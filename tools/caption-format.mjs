// Pure caption/lower-third/CTA formatting helpers used by render-caption.mjs.
//
// Kept separate from render-caption.mjs (which launches a headless Chromium via
// Playwright and runs on import) so this string/argument logic can be unit
// tested without spinning up a browser. The only I/O here is reading an SVG
// icon off disk in `iconImg`; everything else is a pure function of its inputs.
import { readFileSync } from "node:fs";

// Per-frame opacity/translate keyframes for the fade-in and fade-out. Exported
// so render-caption.mjs builds its animation timeline from the same source of
// truth the tests assert against.
export const IN_STEPS = [
  [0.12, 26],
  [0.4, 16],
  [0.68, 9],
  [0.88, 4],
  [1, 0],
];
export const OUT_STEPS = [
  [0.8, -3],
  [0.58, -6],
  [0.36, -9],
  [0.16, -12],
  [0, -15],
];

const DEFAULTS = {
  style: "pill",
  position: "lower-third",
  duration: 2.0,
  fps: 24,
  width: 1920,
  height: 1080,
  accent: "#ff5a00",
  font: "'Avenir Next','Helvetica Neue',Arial,sans-serif",
};

// Parse argv into an options object. `help` is the text printed for --help; the
// caller owns it so the help reflects render-caption's own usage block.
export function parseArgs(argv, help = "") {
  const o = { ...DEFAULTS, text: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--help" || a === "-h") { console.log(help); process.exit(0); }
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
export function namespaceSvgIds(svg, uid) {
  const ids = [...new Set([...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))];
  for (const id of ids) {
    const e = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    svg = svg.replace(new RegExp(`id="${e}"`, "g"), `id="${uid}_${id}"`)
      .replace(new RegExp(`url\\(#${e}\\)`, "g"), `url(#${uid}_${id})`)
      .replace(new RegExp(`((?:xlink:)?href)="#${e}"`, "g"), `$1="#${uid}_${id}"`);
  }
  return svg;
}

export function iconImg(path, size) {
  const svg = namespaceSvgIds(readFileSync(path, "utf8"), "ic");
  const uri = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
  return `<img src="${uri}" width="${size}" height="${size}" style="display:block;flex:none;border-radius:${Math.round(size * 0.2)}px;filter:drop-shadow(0 4px 12px rgba(0,0,0,.4));"/>`;
}

// ── content blocks ────────────────────────────────────────────────────────
export function block(o) {
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

export function wrapPos(inner, o, opacity, ty) {
  const pos = o.position === "center"
    ? `top:0;bottom:0;align-items:center;`
    : o.position === "upper-third"
      ? `top:${Math.round(o.height * 0.14)}px;align-items:flex-start;`
      : `bottom:${Math.round(o.height * 0.11)}px;align-items:flex-end;`;
  return `<div style="position:absolute;left:0;right:0;${pos}display:flex;justify-content:center;opacity:${opacity};transform:translateY(${ty}px);">${inner}</div>`;
}

export function buildPage(o, opacity, ty) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box} html,body{background:transparent}
    body{width:${o.width}px;height:${o.height}px;overflow:hidden;font-family:sans-serif}
    .stage{position:relative;width:${o.width}px;height:${o.height}px}
  </style></head><body><div class="stage">${wrapPos(block(o), o, opacity, ty)}</div></body></html>`;
}

// Build the per-frame animation specs (fade-in keyframes → single long hold →
// fade-out keyframes). `FU` is one frame in ms. The hold absorbs the loop fade.
export function buildSpecs(o) {
  const FU = 1000 / o.fps;
  const holdMs = Math.max(FU, o.duration * 1000 - 10 * FU);
  return [
    ...IN_STEPS.map(([op, ty]) => ({ op, ty, dur: FU })),
    { op: 1, ty: 0, dur: holdMs },
    ...OUT_STEPS.map(([op, ty]) => ({ op, ty, dur: FU })),
  ];
}

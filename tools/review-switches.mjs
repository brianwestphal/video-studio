#!/usr/bin/env node
/**
 * review-switches — resolve low-confidence auto multi-cam cuts by hand
 * (docs/multicam-review-ui.md, R-RUI; VS-65). Reads a synced group (multicam.json) +
 * an autoCut `switches.json` (which carries the R-AC9 review signal), pre-extracts a
 * short ±context clip of each candidate angle for every flagged cut, and serves a local
 * page where you pick the winning angle per cut. On save it rewrites switches.json in
 * place (after a .bak) + appends a change history (switches.history.json), then prints
 * the ready export line.
 *
 * Usage:
 *   review-switches <multicam.json> --switches <switches.json> [options]
 *     --group <id>            group id (default: first group)
 *     --context <sec>         seconds of lead/tail context per preview (default 2)
 *     --port <n>              server port (default 8777)
 *     --all                   review every cut, not just the flagged ones
 *
 * Pure logic (which cuts to surface, candidate angles, applying picks + history) is in
 * ./review-model.mjs (100% unit-tested); this file is the HTTP server + ffmpeg preview
 * extraction + browser launch (out of automated scope — docs/manual-test-plan.md).
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { applyReview, candidateAngles, reviewSegments } from "./review-model.mjs";
import { sourceTime } from "./visual-saliency.mjs";

function parseArgs(argv) {
  const o = { file: undefined, switches: undefined, group: undefined, contextSeconds: 2, port: 8777, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--switches") o.switches = argv[++i];
    else if (a === "--group") o.group = argv[++i];
    else if (a === "--context") o.contextSeconds = Number(argv[++i]);
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--all") o.all = true;
    else if (a === "-h" || a === "--help") { console.log("Usage: review-switches <multicam.json> --switches <switches.json> [--group id] [--context s] [--port n] [--all]"); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else o.file = a;
  }
  if (!o.file) { console.error("Error: a multicam.json path is required."); process.exit(2); }
  if (!o.switches) { console.error("Error: --switches <switches.json> is required."); process.exit(2); }
  return o;
}

// Decode a short preview of one angle covering [previewStart, previewEnd] on the group
// clock into `dest` (silent, downscaled). Returns false if ffmpeg fails (missing angle).
function extractClip(member, previewStart, previewEnd, dest) {
  const ss = Math.max(0, sourceTime(previewStart, member));
  const dur = Math.max(0.1, previewEnd - previewStart);
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(ss), "-i", member.path, "-t", String(dur), "-an", "-vf", "scale=480:-2", "-movflags", "+faststart", dest]);
    return true;
  } catch {
    return false;
  }
}

function page(groupId, count) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Review cuts — ${groupId}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.5 -apple-system, system-ui, sans-serif; background: #12141a; color: #e7e9ee; }
  header { position: sticky; top: 0; background: #1a1d26; padding: 14px 20px; border-bottom: 1px solid #2c3040; display: flex; justify-content: space-between; align-items: center; z-index: 2; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  main { padding: 20px; max-width: 1100px; margin: 0 auto; }
  .seg { background: #1a1d26; border: 1px solid #2c3040; border-radius: 10px; padding: 16px; margin-bottom: 18px; }
  .seg h2 { font-size: 14px; margin: 0 0 4px; font-weight: 600; }
  .why { color: #9aa0ad; font-size: 13px; margin: 0 0 12px; }
  .why code { color: #c8a; }
  .cands { display: flex; flex-wrap: wrap; gap: 12px; }
  .cand { border: 2px solid #2c3040; border-radius: 8px; padding: 8px; cursor: pointer; background: #12141a; transition: border-color .1s; }
  .cand.sel { border-color: #6ea8fe; }
  .cand.auto .tag { color: #8fbf8f; }
  .cand video { display: block; width: 260px; border-radius: 4px; background: #000; }
  .cand .tag { font: 12px/1.4 ui-monospace, monospace; margin-top: 6px; display: flex; justify-content: space-between; }
  .note { width: 100%; margin-top: 10px; background: #12141a; color: #e7e9ee; border: 1px solid #2c3040; border-radius: 6px; padding: 6px 8px; font: inherit; box-sizing: border-box; }
  button { font: 600 14px system-ui; background: #6ea8fe; color: #0a0c12; border: 0; border-radius: 7px; padding: 9px 16px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: #9aa0ad; font-size: 13px; }
  pre { background: #0c0e14; border: 1px solid #2c3040; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
</style></head><body>
<header><h1>Review ${count} cut${count === 1 ? "" : "s"} — ${groupId}</h1><div><span id="status"></span> &nbsp; <button id="save">Save picks</button></div></header>
<main id="root">Loading…</main>
<script>
const fmt = (s) => Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
let SEGS = [];
fetch("data").then(r=>r.json()).then(d=>{ SEGS = d.segments; render(); });
function render(){
  const root = document.getElementById("root");
  root.innerHTML = "";
  for (const seg of SEGS){
    const el = document.createElement("section"); el.className="seg";
    el.innerHTML = "<h2>Cut at "+fmt(seg.atSeconds)+" — auto picked <code>"+seg.chosen+"</code></h2>"+
      "<p class='why'>"+(seg.why||"")+" · confidence <code>"+(seg.confidence==null?"?":seg.confidence)+"</code></p>";
    const cands = document.createElement("div"); cands.className="cands";
    for (const c of seg.candidates){
      const card = document.createElement("label");
      card.className = "cand"+(c===seg.pick?" sel":"")+(c===seg.chosen?" auto":"");
      card.innerHTML = "<video src='clip/"+seg.index+"-"+encodeURIComponent(c)+".mp4' muted loop autoplay playsinline></video>"+
        "<div class='tag'><span>"+c+"</span><span>"+(c===seg.chosen?"auto":"")+"</span></div>";
      card.onclick = () => { seg.pick = c; render(); };
      cands.appendChild(card);
    }
    el.appendChild(cands);
    const note = document.createElement("input"); note.className="note"; note.placeholder="note (optional) — why this angle?"; note.value = seg.note||"";
    note.oninput = () => { seg.note = note.value; };
    el.appendChild(note);
    root.appendChild(el);
  }
}
document.getElementById("save").onclick = async () => {
  const choices = SEGS.filter(s => s.pick && s.pick !== s.chosen).map(s => ({ index: s.index, memberId: s.pick, note: s.note||null }));
  document.getElementById("save").disabled = true;
  const res = await fetch("save", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ choices }) });
  const out = await res.json();
  document.getElementById("status").textContent = out.changed+" change(s) saved";
  const root = document.getElementById("root");
  const pre = document.createElement("pre"); pre.textContent = "Saved "+out.switchesPath+"\\n\\nNext:\\n"+out.exportHint; root.prepend(pre);
};
</script></body></html>`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.file)) { console.error(`Error: not found: ${opts.file}`); process.exit(1); }
  if (!existsSync(opts.switches)) { console.error(`Error: not found: ${opts.switches}`); process.exit(1); }
  const doc = JSON.parse(readFileSync(opts.file, "utf8"));
  const groups = doc.groups || [doc];
  const group = opts.group ? groups.find((g) => g.id === opts.group) : groups[0];
  if (!group) { console.error(`Error: group not found: ${opts.group}`); process.exit(1); }
  const membersById = new Map((group.members || []).map((m) => [m.id, m]));

  const switchesPath = isAbsolute(opts.switches) ? opts.switches : resolve(opts.switches);
  const switchDoc = JSON.parse(readFileSync(switchesPath, "utf8"));
  const videos = (group.members || []).filter((m) => m.kind === "video");
  const master = (group.members || []).find((m) => m.id === group.masterAudioId);
  const timelineEnd = master?.durationSeconds ?? Math.max(0, ...videos.map((m) => m.durationSeconds || 0));

  const segments = reviewSegments({ switches: switchDoc.switches, rationale: switchDoc.rationale, timelineEnd, contextSeconds: opts.contextSeconds, includeAll: opts.all });
  if (segments.length === 0) {
    console.log(opts.all ? "No cuts in switches.json." : "No flagged cuts to review — every auto pick was confident. (Use --all to review anyway.)");
    process.exit(0);
  }

  const tmp = mkdtempSync(join(tmpdir(), "vs-review-"));
  console.log(`Extracting previews for ${segments.length} cut(s)…`);
  for (const seg of segments) {
    seg.candidates = candidateAngles(group, seg).filter((id) => membersById.has(id));
    seg.pick = seg.chosen;
    for (const id of seg.candidates) {
      extractClip(membersById.get(id), seg.previewStart, seg.previewEnd, join(tmp, `${seg.index}-${id}.mp4`));
    }
  }

  const exportHintFor = (p) => `export-multicam-fcpxml ${opts.file} --switches ${p} --width <w> --height <h>`;
  const historyPath = switchesPath.replace(/\.json$/, "") + ".history.json";
  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/") { res.setHeader("content-type", "text/html"); res.end(page(group.id, segments.length)); return; }
    if (url === "/data") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ groupId: group.id, segments })); return; }
    if (url.startsWith("/clip/")) {
      const clip = join(tmp, basename(decodeURIComponent(url.slice("/clip/".length))));
      if (existsSync(clip)) { res.setHeader("content-type", "video/mp4"); res.end(readFileSync(clip)); } else { res.statusCode = 404; res.end("no clip"); }
      return;
    }
    if (url === "/save" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const choices = (JSON.parse(body || "{}").choices) || [];
        const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")).history || [] : [];
        const applied = applyReview({ switches: switchDoc.switches, history, choices, timestamp: new Date().toISOString() });
        if (applied.history.length > history.length) {
          copyFileSync(switchesPath, switchesPath + ".bak");
          writeFileSync(switchesPath, JSON.stringify({ ...switchDoc, switches: applied.switches }, null, 2) + "\n");
          writeFileSync(historyPath, JSON.stringify({ version: 1, history: applied.history }, null, 2) + "\n");
          switchDoc.switches = applied.switches;
        }
        const changed = applied.history.length - history.length;
        console.log(`Saved ${changed} change(s) → ${switchesPath}${changed ? ` (backup ${basename(switchesPath)}.bak)` : ""}`);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ changed, switchesPath, exportHint: exportHintFor(switchesPath) }));
      });
      return;
    }
    res.statusCode = 404; res.end("not found");
  });

  server.listen(opts.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${opts.port}/`;
    console.log(`Review UI at ${url} — pick angles for ${segments.length} flagged cut(s), then Save. Ctrl-C to quit.`);
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    try { spawn(opener, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* headless: the URL is printed above */ }
  });
  process.on("SIGINT", () => { rmSync(tmp, { recursive: true, force: true }); process.exit(0); });
}

main();

#!/usr/bin/env node
/**
 * review-switches — resolve low-confidence auto multi-cam cuts by hand
 * (docs/multicam-review-ui.md, R-RUI; VS-65/67). Reads a synced group (multicam.json) +
 * an autoCut `switches.json` (which carries the R-AC9 review signal), pre-extracts a
 * short ±context clip of each candidate angle for every flagged cut, and serves a local
 * page where you pick the winning angle per cut. With `--audio-events` + `--saliency`
 * it can also **re-propose** the downstream still-auto cuts around your confirmed picks
 * (R-RUI7, opt-in button). On save it rewrites switches.json in place (after a .bak) +
 * appends a change history (switches.history.json), then prints the export line.
 *
 * Usage:
 *   review-switches <multicam.json> --switches <switches.json> [options]
 *     --group <id>            group id (default: first group)
 *     --audio-events <path>   audio-events.json — enables the re-propose button (R-RUI7)
 *     --saliency <path>       saliency.json — enables the re-propose button (R-RUI7)
 *     --context <sec>         seconds of lead/tail context per preview (default 2)
 *     --port <n>              server port (default 8777)
 *     --all                   review every cut, not just the flagged ones
 *
 * Pure logic (which cuts to surface, candidate angles, applying picks + history) is in
 * ./review-model.mjs and the selection/locks/variety model is ./multicam-autocut.mjs
 * (both 100% unit-tested); this file is the HTTP server + ffmpeg preview extraction +
 * browser launch (out of automated scope — docs/manual-test-plan.md §13).
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { autoCut } from "./multicam-autocut.mjs";
import { applyReview, candidateAngles, reviewSegments } from "./review-model.mjs";
import { sourceTime } from "./visual-saliency.mjs";

function parseArgs(argv) {
  const o = { file: undefined, switches: undefined, group: undefined, audioEvents: undefined, saliency: undefined, contextSeconds: 2, port: 8777, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--switches") o.switches = argv[++i];
    else if (a === "--group") o.group = argv[++i];
    else if (a === "--audio-events") o.audioEvents = argv[++i];
    else if (a === "--saliency") o.saliency = argv[++i];
    else if (a === "--context") o.contextSeconds = Number(argv[++i]);
    else if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--all") o.all = true;
    else if (a === "-h" || a === "--help") { console.log("Usage: review-switches <multicam.json> --switches <switches.json> [--group id] [--audio-events p] [--saliency p] [--context s] [--port n] [--all]"); process.exit(0); }
    else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else o.file = a;
  }
  if (!o.file) { console.error("Error: a multicam.json path is required."); process.exit(2); }
  if (!o.switches) { console.error("Error: --switches <switches.json> is required."); process.exit(2); }
  return o;
}

const readJson = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

// Decode a short preview of one angle covering [previewStart, previewEnd] on the group
// clock into `dest` (downscaled, audio kept so the reviewer can audition one at a time —
// VS-71). Returns false if ffmpeg fails (missing angle).
function extractClip(member, previewStart, previewEnd, dest) {
  const ss = Math.max(0, sourceTime(previewStart, member));
  const dur = Math.max(0.1, previewEnd - previewStart);
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(ss), "-i", member.path, "-t", String(dur), "-vf", "scale=480:-2", "-ac", "1", "-movflags", "+faststart", dest]);
    return true;
  } catch {
    return false;
  }
}

// A stable, index-free clip filename (keyed by cut time) so re-proposing reuses the
// previews it already extracted for unchanged cuts.
const clipName = (atSeconds, id) => `${Math.round(atSeconds * 1000)}-${id.replace(/[^\w.-]/g, "_")}.mp4`;

function page(groupId, count, canRepropose) {
  const reBtn = canRepropose ? '<button id="repropose" title="Re-flow the un-locked cuts around your picks">Re-propose downstream</button> &nbsp;' : "";
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
  .seg.active { border-color: #3a4258; box-shadow: 0 0 0 1px #6ea8fe33; }
  .legend { color: #9aa0ad; font-size: 12px; margin-top: 3px; }
  .legend .swatch { display: inline-block; width: 22px; height: 8px; border-radius: 3px; background: #6ea8fe66; vertical-align: middle; }
  .transport { display: flex; align-items: center; gap: 10px; margin: 4px 0 12px; }
  /* Scrubber: a custom track so the "section of interest" (the shot this cut introduces)
     shows as a band, with a tick at the exact cut time; the clip ends are ±context. */
  .seekwrap { position: relative; flex: 1; height: 20px; display: flex; align-items: center; }
  .seekwrap .track { position: absolute; left: 0; right: 0; height: 6px; background: #2c3040; border-radius: 3px; }
  .seekwrap .band { position: absolute; height: 6px; background: #6ea8fe66; border-radius: 3px; }
  .seekwrap .cut { position: absolute; width: 2px; height: 16px; background: #6ea8fe; transform: translateX(-1px); }
  .seekwrap .seek { position: absolute; left: 0; right: 0; width: 100%; margin: 0; background: transparent; -webkit-appearance: none; appearance: none; }
  .seekwrap .seek::-webkit-slider-runnable-track { background: transparent; height: 16px; }
  .seekwrap .seek::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #e7e9ee; border: 1px solid #12141a; cursor: pointer; margin-top: 1px; }
  .seekwrap .seek::-moz-range-track { background: transparent; }
  .seekwrap .seek::-moz-range-thumb { width: 13px; height: 13px; border-radius: 50%; background: #e7e9ee; border: 1px solid #12141a; cursor: pointer; }
  .transport .time { font: 12px/1 ui-monospace, monospace; color: #9aa0ad; min-width: 92px; text-align: right; }
  .cands { display: flex; flex-wrap: wrap; gap: 12px; }
  .cand { border: 2px solid #2c3040; border-radius: 8px; padding: 8px; background: #12141a; transition: border-color .1s; }
  .cand.sel { border-color: #6ea8fe; }
  .cand.aud { box-shadow: inset 0 0 0 1px #8fbf8f; }
  .cand.auto .tag { color: #8fbf8f; }
  .cand video { display: block; width: 260px; border-radius: 4px; background: #000; }
  .cand .tag { font: 12px/1.4 ui-monospace, monospace; margin-top: 6px; display: flex; justify-content: space-between; }
  .cand .ctl { display: flex; gap: 6px; margin-top: 6px; }
  .cand .ctl button { padding: 4px 9px; font: 600 12px system-ui; background: #2c3040; color: #e7e9ee; }
  .cand .ctl button.on { background: #6ea8fe; color: #0a0c12; }
  .note { width: 100%; margin-top: 10px; background: #12141a; color: #e7e9ee; border: 1px solid #2c3040; border-radius: 6px; padding: 6px 8px; font: inherit; box-sizing: border-box; }
  button { font: 600 14px system-ui; background: #6ea8fe; color: #0a0c12; border: 0; border-radius: 7px; padding: 9px 16px; cursor: pointer; }
  button.pp { min-width: 68px; }
  button#repropose { background: #2c3040; color: #e7e9ee; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: #9aa0ad; font-size: 13px; }
  pre { background: #0c0e14; border: 1px solid #2c3040; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
</style></head><body>
<header><div><h1>Review <span id="count">${count}</span> cut(s) — ${groupId}</h1><div class="legend">On the scrubber, the <span class="swatch"></span> band is the shot this cut introduces; the clip ends are ±context lead-in/out.</div></div><div><span id="status"></span> &nbsp; ${reBtn}<button id="save">Save picks</button></div></header>
<main id="root">Loading…</main>
<script>
const fmt = (s) => Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
const fmt1 = (s) => Math.floor(s/60)+":"+(s%60).toFixed(1).padStart(4,"0"); // m:ss.d
let SEGS = [];
// Runtime playback controllers, one per rendered segment. Only ONE segment plays at a
// time (VS-71): starting a segment pauses every other, so audio is single-source.
let controllers = [];
function activate(i){ for (let k=0;k<controllers.length;k++) if (k!==i) controllers[k].pause(); }
function setSegs(segs){ controllers = []; SEGS = segs.map(s => ({...s, pick: s.chosen, note: ""})); document.getElementById("count").textContent = SEGS.length; render(); }
fetch("data").then(r=>r.json()).then(d=>setSegs(d.segments));
function render(){
  const root = document.getElementById("root");
  root.innerHTML = ""; controllers = [];
  SEGS.forEach((seg, i) => root.appendChild(buildSeg(seg, i)));
}
// Build one flagged-cut segment: its candidate angle clips share a single transport
// (play/pause + seek) and play in lockstep off a leader clock; exactly one clip is
// unmuted (audio focus, defaults to the pick); any clip can go fullscreen (VS-71).
function buildSeg(seg, i){
  const el = document.createElement("section"); el.className = "seg";
  el.innerHTML = "<h2>Cut at "+fmt(seg.atSeconds)+" — auto picked <code>"+seg.chosen+"</code></h2>"+
    "<p class='why'>"+(seg.why||"")+" · confidence <code>"+(seg.confidence==null?"?":seg.confidence)+"</code>"+
    " · section <code>"+fmt1(seg.atSeconds)+"–"+fmt1(seg.endSeconds)+"</code></p>";

  const bar = document.createElement("div"); bar.className = "transport";
  const pp = document.createElement("button"); pp.className = "pp"; pp.textContent = "Play";
  // Scrubber with the section-of-interest band. Positions are fractions of the preview
  // window [previewStart, previewEnd] (the clip's span), so they match the bar regardless
  // of the decoded clip's exact duration.
  const seekwrap = document.createElement("div"); seekwrap.className = "seekwrap";
  const track = document.createElement("div"); track.className = "track";
  const band = document.createElement("div"); band.className = "band";
  const cut = document.createElement("div"); cut.className = "cut";
  const winDur = seg.previewEnd - seg.previewStart;
  const pct = (t) => Math.max(0, Math.min(100, winDur > 0 ? (t - seg.previewStart)/winDur*100 : 0));
  const inA = pct(seg.atSeconds), inB = pct(seg.endSeconds);
  band.style.left = inA+"%"; band.style.width = (inB-inA)+"%"; cut.style.left = inA+"%";
  const seek = document.createElement("input"); seek.type = "range"; seek.className = "seek"; seek.min = "0"; seek.max = "1000"; seek.value = "0"; seek.step = "1";
  seekwrap.append(track, band, cut, seek);
  const time = document.createElement("span"); time.className = "time"; time.textContent = "0:00 / 0:00";
  bar.append(pp, seekwrap, time); el.appendChild(bar);

  const cands = document.createElement("div"); cands.className = "cands";
  const vids = []; // { id, video, card, audBtn }
  let audioId = seg.pick;   // which clip is audible when this segment plays
  let playing = false;
  for (const c of seg.candidates){
    const card = document.createElement("div");
    card.className = "cand"+(c.id===seg.pick?" sel":"")+(c.auto?" auto":"");
    const video = document.createElement("video"); video.src = c.url; video.muted = true; video.playsInline = true; video.preload = "auto";
    const tag = document.createElement("div"); tag.className = "tag";
    tag.innerHTML = "<span>"+c.id+"</span><span>"+(c.auto?"auto":"")+"</span>";
    const ctl = document.createElement("div"); ctl.className = "ctl";
    const pickBtn = document.createElement("button"); pickBtn.textContent = c.id===seg.pick?"Picked":"Pick"; if (c.id===seg.pick) pickBtn.classList.add("on");
    const audBtn = document.createElement("button"); audBtn.textContent = "Audio"; if (c.id===audioId) audBtn.classList.add("on");
    const fsBtn = document.createElement("button"); fsBtn.textContent = "Full";
    ctl.append(pickBtn, audBtn, fsBtn); card.append(video, tag, ctl); cands.appendChild(card);
    const entry = { id: c.id, video, card, audBtn }; vids.push(entry);
    pickBtn.onclick = () => setPick(c.id);
    audBtn.onclick = () => setAudio(c.id);
    fsBtn.onclick = () => { setAudio(c.id); if (!playing) play(); (video.requestFullscreen||video.webkitRequestFullscreen||(()=>{})).call(video); };
  }
  el.appendChild(cands);

  const note = document.createElement("input"); note.className = "note"; note.placeholder = "note (optional) — why this angle?"; note.value = seg.note||"";
  note.oninput = () => { seg.note = note.value; };
  el.appendChild(note);

  const leader = () => vids[0].video;
  const applyMute = () => { for (const v of vids) v.video.muted = !(playing && v.id === audioId); };
  function setAudio(id){ audioId = id; for (const v of vids) v.audBtn.classList.toggle("on", v.id === id); applyMute(); }
  function setPick(id){
    seg.pick = id;
    for (const v of vids){ const b = v.card.querySelector(".ctl button"); v.card.classList.toggle("sel", v.id===id); b.textContent = v.id===id?"Picked":"Pick"; b.classList.toggle("on", v.id===id); }
  }
  function play(){
    activate(i); el.classList.add("active"); playing = true; pp.textContent = "Pause";
    const t = leader().currentTime; for (const v of vids){ v.video.currentTime = t; v.video.play().catch(()=>{}); }
    applyMute();
  }
  function pause(){ playing = false; pp.textContent = "Play"; el.classList.remove("active"); for (const v of vids) v.video.pause(); applyMute(); }
  pp.onclick = () => (playing ? pause() : play());
  seek.oninput = () => { const d = leader().duration||0; const t = d*seek.value/1000; for (const v of vids) v.video.currentTime = t; };
  leader().addEventListener("timeupdate", () => {
    const d = leader().duration||0, t = leader().currentTime;
    seek.value = d ? String(Math.round(t/d*1000)) : "0";
    time.textContent = fmt(t)+" / "+fmt(d);
    for (const v of vids) if (v.video!==leader() && Math.abs(v.video.currentTime - t) > 0.2) v.video.currentTime = t; // keep angles synced
  });
  leader().addEventListener("ended", () => { for (const v of vids){ v.video.currentTime = 0; if (playing) v.video.play().catch(()=>{}); } }); // loop the segment
  controllers[i] = { pause: () => { if (playing) pause(); } };
  return el;
}
const locksOf = () => SEGS.filter(s => s.pick !== s.chosen).map(s => ({ atSeconds: s.atSeconds, memberId: s.pick }));
const choicesOf = () => SEGS.filter(s => s.pick !== s.chosen).map(s => ({ index: s.index, memberId: s.pick, note: s.note||null }));
const rebtn = document.getElementById("repropose");
if (rebtn) rebtn.onclick = async () => {
  rebtn.disabled = true;
  const res = await fetch("repropose", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ locks: locksOf() }) });
  const out = await res.json();
  setSegs(out.segments);
  document.getElementById("status").textContent = "re-proposed — "+out.segments.length+" cut(s) still flagged";
  rebtn.disabled = false;
};
document.getElementById("save").onclick = async () => {
  document.getElementById("save").disabled = true;
  const res = await fetch("save", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ choices: choicesOf() }) });
  const out = await res.json();
  document.getElementById("status").textContent = out.changed+" change(s) saved";
  const pre = document.createElement("pre"); pre.textContent = "Saved "+out.switchesPath+"\\n\\nNext:\\n"+out.exportHint;
  document.getElementById("root").prepend(pre);
  document.getElementById("save").disabled = false;
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
  const audioEvents = readJson(opts.audioEvents);
  const saliency = readJson(opts.saliency);
  const canRepropose = Boolean(audioEvents && saliency);
  const videos = (group.members || []).filter((m) => m.kind === "video");
  const master = (group.members || []).find((m) => m.id === group.masterAudioId);
  const timelineEnd = master?.durationSeconds ?? Math.max(0, ...videos.map((m) => m.durationSeconds || 0));

  const tmp = mkdtempSync(join(tmpdir(), "vs-review-"));
  const historyPath = switchesPath.replace(/\.json$/, "") + ".history.json";
  let baseline = JSON.stringify(switchDoc.switches);
  let curSwitches = switchDoc.switches;
  let curRationale = switchDoc.rationale || [];
  const reproposeLog = []; // in-memory re-propose events, persisted to history on save

  // Compute the reviewable segments from the current switch list, attaching candidate
  // angles + their (cached) preview clips.
  const buildSegments = () => {
    const segs = reviewSegments({ switches: curSwitches, rationale: curRationale, timelineEnd, contextSeconds: opts.contextSeconds, includeAll: opts.all });
    for (const seg of segs) {
      seg.candidates = candidateAngles(group, seg).filter((id) => membersById.has(id)).map((id) => {
        const file = clipName(seg.atSeconds, id);
        const dest = join(tmp, file);
        if (!existsSync(dest)) extractClip(membersById.get(id), seg.previewStart, seg.previewEnd, dest);
        return { id, url: `clip/${file}`, auto: id === seg.chosen };
      });
    }
    return segs;
  };

  console.log(`Extracting previews…${canRepropose ? " (re-propose enabled)" : ""}`);
  let segments = buildSegments();
  if (segments.length === 0) {
    console.log(opts.all ? "No cuts in switches.json." : "No flagged cuts to review — every auto pick was confident. (Use --all to review anyway.)");
    rmSync(tmp, { recursive: true, force: true });
    process.exit(0);
  }

  const exportHint = `export-multicam-fcpxml ${opts.file} --switches ${switchesPath} --width <w> --height <h>`;
  const readBody = (req) => new Promise((res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => res(b)); });

  const server = createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/") { res.setHeader("content-type", "text/html"); res.end(page(group.id, segments.length, canRepropose)); return; }
    if (url === "/data") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ groupId: group.id, canRepropose, segments })); return; }
    if (url.startsWith("/clip/")) {
      const clip = join(tmp, basename(decodeURIComponent(url.slice("/clip/".length))));
      if (existsSync(clip)) { res.setHeader("content-type", "video/mp4"); res.end(readFileSync(clip)); } else { res.statusCode = 404; res.end("no clip"); }
      return;
    }
    if (url === "/repropose" && req.method === "POST") {
      if (!canRepropose) { res.statusCode = 400; res.end('{"error":"re-propose needs --audio-events and --saliency"}'); return; }
      const locks = JSON.parse((await readBody(req)) || "{}").locks || [];
      const r = autoCut({ group, audioEvents, saliency, locks });
      curSwitches = r.switches;
      curRationale = r.rationale;
      reproposeLog.push({ at: new Date().toISOString(), reproposedWithLocks: locks.length });
      segments = buildSegments();
      console.log(`Re-proposed with ${locks.length} locked pick(s) → ${curSwitches.length} switch(es), ${segments.length} still flagged.`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ segments }));
      return;
    }
    if (url === "/save" && req.method === "POST") {
      const choices = JSON.parse((await readBody(req)) || "{}").choices || [];
      const fileHistory = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")).history || [] : [];
      const applied = applyReview({ switches: curSwitches, choices, timestamp: new Date().toISOString() });
      curSwitches = applied.switches;
      const changed = JSON.stringify(curSwitches) !== baseline;
      const edits = reproposeLog.length + applied.history.length; // history entries this save
      if (changed) {
        if (!existsSync(switchesPath + ".bak")) copyFileSync(switchesPath, switchesPath + ".bak"); // keep the ORIGINAL
        writeFileSync(switchesPath, JSON.stringify({ ...switchDoc, switches: curSwitches }, null, 2) + "\n");
        writeFileSync(historyPath, JSON.stringify({ version: 1, history: [...fileHistory, ...reproposeLog, ...applied.history] }, null, 2) + "\n");
        reproposeLog.length = 0;
        baseline = JSON.stringify(curSwitches); // so a no-op re-save doesn't rewrite / re-.bak
      }
      console.log(`Saved → ${switchesPath}${changed ? ` (backup ${basename(switchesPath)}.bak)` : " (no change)"}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ changed: changed ? edits : 0, switchesPath, exportHint }));
      return;
    }
    res.statusCode = 404; res.end("not found");
  });

  server.listen(opts.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${opts.port}/`;
    console.log(`Review UI at ${url} — pick angles for ${segments.length} flagged cut(s)${canRepropose ? ", re-propose, " : ", "}then Save. Ctrl-C to quit.`);
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    try { spawn(opener, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* headless: the URL is printed above */ }
  });
  process.on("SIGINT", () => { rmSync(tmp, { recursive: true, force: true }); process.exit(0); });
}

main();

import { REVIEW_ACTIONS, ReviewHeader, ReviewSegments, type ReviewSegment } from "./review-components.js";
import { delegate, mount, signal, toElement } from "./kerf.js";

interface ReviewData { groupId: string; canRepropose: boolean; segments: ReviewSegment[] }
interface AssembledData {
  timelineEnd: number;
  angles: Array<{ id: string; url: string; offset: number; rate: number }>;
  switches: Array<{ atSeconds: number; memberId: string }>;
  rationale: Array<{ flagged?: boolean }>;
}

const segments = signal<ReviewSegment[]>([]);
const status = signal("");
const drawerOpen = signal(false);
let groupId = "";
let canRepropose = false;
let timeline: ReturnType<typeof buildTimeline> | null = null;

const json = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
};
const post = <T,>(url: string, body: unknown) => json<T>(url, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const segmentFrom = (el: Element): ReviewSegment | undefined => {
  const index = Number(el.closest<HTMLElement>("[data-segment]")?.dataset.segment);
  return segments.value.find((segment) => segment.index === index);
};

function App() {
  return <div data-key="review-app" data-ui-runtime="kerfjs">
    <div id="top">
      {ReviewHeader({ groupId, count: segments.value.length, canRepropose, status: status.value })}
      <div id="tldrawer" class={drawerOpen.value ? "open" : ""}>
        <div id="tlbody" data-morph-skip=""></div>
      </div>
    </div>
    {ReviewSegments({ segments: segments.value })}
  </div>;
}

function replaceSegment(next: ReviewSegment) {
  segments.value = segments.value.map((segment) => segment.index === next.index ? next : segment);
  timeline?.onPick();
}

function pauseAll(except?: HTMLElement) {
  document.querySelectorAll<HTMLElement>("[data-segment].active").forEach((section) => {
    if (section === except) return;
    section.classList.remove("active");
    section.querySelectorAll("video").forEach((video) => { video.pause(); video.muted = true; });
    const button = section.querySelector<HTMLButtonElement>(REVIEW_ACTIONS.segmentPlay.selector);
    if (button) button.textContent = "Play";
  });
  timeline?.pause();
}

function playSegment(section: HTMLElement) {
  const videos = [...section.querySelectorAll<HTMLVideoElement>("video")];
  const button = section.querySelector<HTMLButtonElement>(REVIEW_ACTIONS.segmentPlay.selector);
  if (!button || videos.length === 0) return;
  const playing = section.classList.contains("active");
  if (playing) { pauseAll(); return; }
  pauseAll(section);
  section.classList.add("active");
  button.textContent = "Pause";
  const t = videos[0]?.currentTime ?? 0;
  for (const video of videos) { video.currentTime = t; void video.play().catch(() => undefined); }
  const selected = section.querySelector<HTMLElement>(".cand.sel")?.dataset.candidate;
  videos.forEach((video) => { video.muted = video.closest<HTMLElement>("[data-candidate]")?.dataset.candidate !== selected; });
}

const boundLeaders = new WeakSet<HTMLVideoElement>();
function bindPlayback() {
  document.querySelectorAll<HTMLElement>("[data-segment]").forEach((section) => {
    const leader = section.querySelector<HTMLVideoElement>("video");
    if (!leader || boundLeaders.has(leader)) return;
    boundLeaders.add(leader);
    leader.addEventListener("timeupdate", () => {
      const duration = leader.duration || 0;
      const time = leader.currentTime;
      const seek = section.querySelector<HTMLInputElement>(".seek");
      const label = section.querySelector<HTMLElement>(".time");
      if (seek) seek.value = duration ? String(Math.round((time / duration) * 1000)) : "0";
      if (label) label.textContent = `${fmt(time)} / ${fmt(duration)}`;
      section.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
        if (video !== leader && Math.abs(video.currentTime - time) > 0.2) video.currentTime = time;
      });
    });
    leader.addEventListener("ended", () => {
      section.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
        video.currentTime = 0;
        if (section.classList.contains("active")) void video.play().catch(() => undefined);
      });
    });
  });
}

function choices() {
  return segments.value.filter((s) => s.pick !== s.chosen)
    .map((s) => ({ index: s.index, memberId: s.pick, note: s.note || null }));
}
function locks() {
  return segments.value.filter((s) => s.pick !== s.chosen)
    .map((s) => ({ atSeconds: s.atSeconds, memberId: s.pick }));
}

function buildTimeline(data: AssembledData, root: HTMLElement) {
  root.replaceChildren();
  const player = document.createElement("div"); player.className = "player";
  const videos = new Map<string, HTMLVideoElement>();
  for (const angle of data.angles) {
    const video = document.createElement("video"); video.src = angle.url; video.preload = "metadata"; video.muted = true; video.playsInline = true; video.hidden = true;
    player.append(video); videos.set(angle.id, video);
  }
  const controls = document.createElement("div"); controls.className = "tltransport";
  controls.append(toElement(<><button data-tl="play">Play</button><button data-tl="split">Split here</button><button data-tl="add">Add cut to review</button><span class="time"></span><span class="active"></span></>));
  const bar = document.createElement("div"); bar.className = "tlbar";
  root.append(player, controls, bar);
  let gt = 0; let playing = false; let active = "";
  const picks = () => new Map(segments.value.map((s) => [s.index, s.pick]));
  const assembled = () => { const p = picks(); return data.switches.map((s, i) => ({ at: s.atSeconds, id: p.get(i) ?? s.memberId })); };
  const currentCutAt = () => { let at = 0; for (const item of assembled()) { if (item.at <= gt) at = item.at; else break; } return at; };
  const angleAt = (time: number) => { let id = assembled()[0]?.id ?? data.angles[0]?.id ?? ""; for (const s of assembled()) { if (s.at <= time + 1e-6) id = s.id; else break; } return id; };
  const show = (id: string) => { videos.forEach((video, key) => { video.hidden = key !== id; }); active = id; const label = controls.querySelector(".active"); if (label) label.textContent = id ? `● ${id}` : ""; };
  const seek = (time: number) => { gt = Math.max(0, Math.min(data.timelineEnd, time)); const id = angleAt(gt); show(id); const video = videos.get(id); const angle = data.angles.find((a) => a.id === id); if (video && angle) video.currentTime = Math.max(0, (gt - angle.offset) / angle.rate); drawHead(); };
  const drawBar = () => { bar.replaceChildren(); const colors = ["#6ea8fe", "#8fbf8f", "#e0a458", "#c58fd8"]; assembled().forEach((s, i, all) => { const block = document.createElement("div"); block.className = `blk${data.rationale[i]?.flagged ? " flag" : ""}`; block.style.left = `${s.at / data.timelineEnd * 100}%`; block.style.width = `${((all[i + 1]?.at ?? data.timelineEnd) - s.at) / data.timelineEnd * 100}%`; block.style.background = colors[data.angles.findIndex((a) => a.id === s.id) % colors.length] ?? "#555"; bar.append(block); }); const head = document.createElement("div"); head.className = "head"; bar.append(head); drawHead(); };
  const drawHead = () => { const head = bar.querySelector<HTMLElement>(".head"); if (head) head.style.left = `${data.timelineEnd ? gt / data.timelineEnd * 100 : 0}%`; const label = controls.querySelector(".time"); if (label) label.textContent = `${fmt(gt)} / ${fmt(data.timelineEnd)}`; };
  const pause = () => { playing = false; videos.forEach((v) => { v.pause(); v.muted = true; }); const b = controls.querySelector("button"); if (b) b.textContent = "Play"; };
  controls.querySelector('[data-tl="play"]')?.addEventListener("click", () => { if (playing) { pause(); return; } pauseAll(); playing = true; const video = videos.get(active); if (video) { video.muted = false; void video.play().catch(() => undefined); } const b = controls.querySelector("button"); if (b) b.textContent = "Pause"; });
  controls.querySelector('[data-tl="split"]')?.addEventListener("click", async () => { const out = await post<{ split: boolean; segments: ReviewSegment[] }>("split", { atSeconds: gt }); if (out.split) { segments.value = out.segments.map((s) => ({ ...s, pick: s.chosen, note: "" })); queueMicrotask(bindPlayback); } status.value = out.split ? `split added at ${gt.toFixed(1)}s` : "can't split there"; });
  controls.querySelector('[data-tl="add"]')?.addEventListener("click", async () => { const out = await post<{ segments: ReviewSegment[] }>("add-review", { atSeconds: currentCutAt() }); segments.value = out.segments.map((s) => ({ ...s, pick: s.chosen, note: "" })); queueMicrotask(bindPlayback); });
  bar.addEventListener("click", (event) => { const rect = bar.getBoundingClientRect(); seek((event.clientX - rect.left) / rect.width * data.timelineEnd); });
  videos.forEach((video, id) => video.addEventListener("timeupdate", () => { if (id !== active) return; const angle = data.angles.find((a) => a.id === id); if (!angle) return; gt = angle.offset + video.currentTime * angle.rate; const wanted = angleAt(gt); if (playing && wanted !== active) { pause(); seek(gt); playing = true; const next = videos.get(wanted); if (next) { next.muted = false; void next.play().catch(() => undefined); } } drawHead(); }));
  player.addEventListener("dblclick", () => { const video = videos.get(active); if (video) void video.requestFullscreen(); });
  drawBar(); seek(0);
  return { pause, onPick: () => { drawBar(); seek(gt); }, setData: (next: AssembledData) => { data.switches = next.switches; data.rationale = next.rationale; drawBar(); } };
}

async function boot() {
  const root = document.getElementById("review-app");
  if (!root) return;
  const data = await json<ReviewData>("data");
  groupId = data.groupId; canRepropose = data.canRepropose;
  segments.value = data.segments.map((segment) => ({ ...segment, pick: segment.chosen, note: "" }));
  mount(root, App);
  queueMicrotask(bindPlayback);
  const rerender = () => queueMicrotask(bindPlayback);

  void delegate(root, "click", REVIEW_ACTIONS.pick.selector, (_event, button) => { const segment = segmentFrom(button); const id = button.closest<HTMLElement>("[data-candidate]")?.dataset.candidate; if (segment && id) { replaceSegment({ ...segment, pick: id }); rerender(); } });
  void delegate(root, "click", REVIEW_ACTIONS.segmentPlay.selector, (_event, button) => { const section = button.closest<HTMLElement>("[data-segment]"); if (section) playSegment(section); });
  void delegate(root, "input", REVIEW_ACTIONS.segmentSeek.selector, (_event, input) => { const section = input.closest<HTMLElement>("[data-segment]"); const leader = section?.querySelector<HTMLVideoElement>("video"); if (section && leader) section.querySelectorAll<HTMLVideoElement>("video").forEach((video) => { video.currentTime = (leader.duration || 0) * Number((input as HTMLInputElement).value) / 1000; }); });
  void delegate(root, "input", REVIEW_ACTIONS.note.selector, (_event, input) => { const segment = segmentFrom(input); if (segment) replaceSegment({ ...segment, note: (input as HTMLInputElement).value }); });
  void delegate(root, "click", REVIEW_ACTIONS.audio.selector, (_event, button) => { const card = button.closest<HTMLElement>("[data-candidate]"); const section = button.closest<HTMLElement>("[data-segment]"); if (!card || !section) return; section.querySelectorAll<HTMLVideoElement>("video").forEach((video) => { video.muted = video.closest<HTMLElement>("[data-candidate]") !== card; }); });
  void delegate(root, "click", REVIEW_ACTIONS.fullscreen.selector, (_event, button) => { const video = button.closest<HTMLElement>("[data-candidate]")?.querySelector<HTMLVideoElement>("video"); if (video) void video.requestFullscreen(); });
  void delegate(root, "click", REVIEW_ACTIONS.timelineToggle.selector, async () => { drawerOpen.value = !drawerOpen.value; if (drawerOpen.value && !timeline) { const host = document.getElementById("tlbody"); if (host) timeline = buildTimeline(await json<AssembledData>("assembled"), host); } });
  void delegate(root, "click", REVIEW_ACTIONS.repropose.selector, async () => { const out = await post<{ segments: ReviewSegment[] }>("repropose", { locks: locks() }); segments.value = out.segments.map((s) => ({ ...s, pick: s.chosen, note: "" })); status.value = `re-proposed — ${out.segments.length} cut(s) still flagged`; timeline?.setData(await json<AssembledData>("assembled")); rerender(); });
  void delegate(root, "click", REVIEW_ACTIONS.save.selector, async () => { const out = await post<{ changed: number; switchesPath: string; exportHint: string }>("save", { choices: choices() }); status.value = `${out.changed} change(s) saved — ${out.switchesPath}`; });
}

void boot();

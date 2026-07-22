import type { SafeHtml } from "./kerf.js";
import { attr, delegate, each, mount, signal } from "./kerf.js";

type StageKey = "setup" | "new-project" | "analyze" | "design" | "export";
type ScreenKey = StageKey | "permissions";
type StageState = "active" | "idle" | "locked" | "done";
interface Stage { key: StageKey; label: string; state: StageState }
interface ProjectData { name: string; artifacts: string[] }
interface ProjectSnapshot { folder: string; project: ProjectData; stages: Stage[] }
interface RecentConfig { recentProjects?: string[]; policy?: Record<string, string>; rules?: PermissionRule[] }
interface PermissionRule { category: string; decision: string; scope?: string }
interface DoctorRow { label: string; status: string; found: boolean; required: boolean; hint?: string }
interface Interaction { kind: "permission" | "question"; title?: string; description?: string; toolName?: string; category?: string; input?: unknown; payload?: { questions?: Question[] } }
interface Question { question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }
interface SidecarMessage { type: string; id?: number; progress?: Progress; data?: unknown; error?: AppError; interactionId?: string; interaction?: Interaction }
interface Progress { message?: string; label?: string; detail?: string }
interface AppError { message: string; code?: string }
interface Handlers { onProgress?: (progress: Progress) => void; onResult?: (data: never) => void; onError?: (error: AppError) => void }
interface FeedItem { id: number; label: string; detail?: string }
interface ExportState { status: string; running: boolean; outPath?: string | undefined }
interface AudioMapCue { startSeconds: number; endSeconds: number; kind: string; text: string }

const ACTIONS = {
  stage: attr("data-action", "stage"), permissions: attr("data-action", "permissions"), doctor: attr("data-action", "doctor"),
  openProject: attr("data-action", "open-project"), createProject: attr("data-action", "create-project"), recent: attr("data-action", "recent"),
  importRun: attr("data-action", "import-run"), importCancel: attr("data-action", "import-cancel"), analyzeRun: attr("data-action", "analyze-run"), analyzeCancel: attr("data-action", "analyze-cancel"),
  preset: attr("data-action", "preset"), designMake: attr("data-action", "design-make"), timeline: attr("data-action", "timeline"),
  exportRun: attr("data-action", "export-run"), exportCancel: attr("data-action", "export-cancel"), reveal: attr("data-action", "reveal"),
  policy: attr("data-action", "policy"), revoke: attr("data-action", "revoke"), resetRules: attr("data-action", "reset-rules"), interaction: attr("data-action", "interaction"),
  designPrompt: attr("data-role", "design-prompt"),
  previewCue: attr("data-action", "preview-cue"), retryPreview: attr("data-action", "retry-preview"),
} as const;

const defaultStages: Stage[] = [
  { key: "setup", label: "Setup", state: "active" }, { key: "new-project", label: "New Project", state: "idle" },
  { key: "analyze", label: "Analyze", state: "locked" }, { key: "design", label: "Design", state: "locked" }, { key: "export", label: "Export", state: "locked" },
];
const PRESETS = [
  ["Teaser", "a punchy 15-second teaser that hooks the viewer"], ["Trailer", "a 60–90 second trailer that sets up what this is and builds to a hook"],
  ["Highlights", "a highlights reel of the best moments"], ["Summary", "a tight summary that covers the key points in about a minute"],
  ["Sizzle", "an energetic sizzle reel — a fast-paced montage of the most dynamic moments"], ["Soundbites", "the strongest spoken soundbites, tightly cut"],
  ["9:16 reel", "a 9:16 vertical reel for social (Reels / TikTok / Shorts)"], ["Full song (music)", "a full music-video edit cut to the track"],
] as const;
const PERMISSIONS = [
  ["media-processing", "Process video", "ffmpeg / whisper / our pipeline tools", "allow", true],
  ["read-in-project", "Read this project", "read files inside the project folder", "allow", true],
  ["write-in-project", "Write results here", "write outputs into the project folder", "allow", true],
  ["network-egress", "Access the network", "anything beyond local Ollama + the agent API", "ask", true],
  ["other-shell", "Run other commands", "shell that isn't recognized", "ask", true],
  ["destructive", "Delete / write outside the project", "always asks, for your safety", "ask", false],
] as const;

const stages = signal<Stage[]>(defaultStages);
const screen = signal<ScreenKey>("setup");
const project = signal<ProjectSnapshot | null>(null);
const recents = signal<string[]>([]);
const doctorRows = signal<DoctorRow[]>([]);
const doctorStatus = signal("");
const importStatus = signal("");
const importRequest = signal<number | null>(null);
const analyzeStatus = signal("");
const analyzeRequest = signal<number | null>(null);
const designPrompt = signal("");
const designNote = signal("");
const manualNote = signal("");
const feed = signal<FeedItem[]>([]);
const designRunning = signal(false);
const reviewUrl = signal("");
const reviewStatus = signal("");
const config = signal<RecentConfig>({});
const exportsState = signal<Record<string, ExportState>>({ mp4: { status: "ready", running: false }, social: { status: "ready", running: false }, fcpxml: { status: "ready", running: false } });
const previewUrl = signal("");
const previewStatus = signal("");
const audioMap = signal<AudioMapCue[]>([]);
let previewFolder = "";
const activeInteraction = signal<{ interactionId: string; interaction: Interaction } | null>(null);
let autoSessionId: string | null = null;
let feedId = 0;

export function displayState(stage: Stage, selected: ScreenKey): StageState {
  if (stage.state === "locked") return "locked";
  if (stage.key === selected) return "active";
  return stage.state === "done" ? "done" : "idle";
}
export function cutKindFromPrompt(prompt: string): string {
  const value = prompt.toLowerCase();
  if (/\bfull\b|whole|entire/.test(value)) return "full";
  if (/teaser/.test(value)) return "teaser";
  if (/trailer/.test(value)) return "trailer";
  if (/summary|recap/.test(value)) return "summary";
  if (/soundbite|quote/.test(value)) return "soundbites";
  if (/sizzle/.test(value)) return "sizzle";
  return "highlights";
}
export function buildAutoPrompt(prompt: string, snapshot: ProjectSnapshot): string {
  const multicam = snapshot.project.artifacts.includes("multicam");
  const schema = multicam
    ? '{ "switches": [ { "atSeconds": 0, "memberId": "<angle id from multicam.json>" } ], "rationale": "<one line>" }\n(read multicam.json in the project folder for the angle memberIds; use only real ids)'
    : '{ "clips": [ { "in": <startSeconds>, "out": <endSeconds> } ], "rationale": "<one line>" }\n(pick scene ranges from the single video; in/out are seconds, out > in)';
  return `${prompt}\n\n(Project folder: ${snapshot.folder})\n\nWhen you've decided the edit, END your reply with the cut plan as a \`\`\`json code block matching this schema:\n\`\`\`json\n${schema}\n\`\`\``;
}

function Header({ title, sub }: { title: string; sub: string }): SafeHtml { return <header class="screen-head"><h1>{title}</h1><p class="sub">{sub}</p></header>; }
function Rail(): SafeHtml { return <nav class="rail" aria-label="Pipeline stages"><div class="rail-stages">{each(stages.value.map((stage) => ({ ...stage })), (stage) => <button class="stage" data-key={stage.key} data-stage={stage.key} data-state={displayState(stage, screen.value)} disabled={displayState(stage, screen.value) === "locked"} {...ACTIONS.stage.attrs}>{stage.label}</button>)}</div><button class="rail-settings" {...ACTIONS.permissions.attrs}>Permissions</button></nav>; }
function Setup(): SafeHtml { return <section class="screen" data-screen="setup" hidden={screen.value !== "setup"}><Header title="Setup" sub="video-studio runs external tools. This checks what's installed — nothing is assumed."/><button class="btn" {...ACTIONS.doctor.attrs}>Check tools</button><ul class="doctor">{doctorStatus.value ? <li class="doctor-row">{doctorStatus.value}</li> : ""}{each(doctorRows.value, (row, index) => <li class={`doctor-row ${row.status}`} data-key={`${row.label}-${index}`}><span class="dot">{row.found ? "●" : "○"}</span><span class="name">{row.label}</span><span class="tag">{row.required ? "required" : "optional"}</span>{row.found ? "" : <span class="hint">{row.hint || ""}</span>}</li>)}</ul></section>; }
function NewProject(): SafeHtml { const snap = project.value; const imported = Boolean(snap?.project.artifacts.some((a) => a === "sources" || a === "multicam")); const artifactItems = each((snap?.project.artifacts || []).map((name) => ({ name })), (item) => <li class="artifact" data-key={item.name}>{item.name}</li>); const recentItems = each(recents.value.map((folder) => ({ folder })), (item) => <button class="recent-project" data-key={item.folder} data-folder={item.folder} {...ACTIONS.recent.attrs}><span class="recent-name">{item.folder.split("/").filter(Boolean).at(-1) || item.folder}</span><span class="recent-path">{item.folder}</span></button>); return <section class="screen" data-screen="new-project" hidden={screen.value !== "new-project"}><Header title="New Project" sub="Open a folder of footage. The filesystem is the source of truth."/><div class="row"><button class="btn" {...ACTIONS.openProject.attrs}>Open project folder…</button><button class="btn" {...ACTIONS.createProject.attrs}>Create here…</button></div>{recents.value.length ? <div class="recent-projects"><h2>Recent projects</h2><div class="recent-list">{recentItems}</div></div> : ""}{snap ? <div class="project-info"><div class="project-name">{snap.project.name}</div><div class="project-folder">{snap.folder}</div><ul class="artifacts">{imported ? artifactItems : <li class="artifact none">No footage imported yet. Analyze this folder's video(s) to begin.</li>}</ul>{!imported ? <div class="import-box"><button class="btn primary" disabled={importRequest.value !== null} {...ACTIONS.importRun.attrs}>Analyze this footage</button>{importRequest.value !== null ? <button class="btn small" {...ACTIONS.importCancel.attrs}>Cancel</button> : ""}<div class="import-status">{importStatus.value}</div></div> : ""}</div> : ""}</section>; }
function Analyze(): SafeHtml { const snap = project.value; const done = snap?.project.artifacts.includes("audioEvents"); return <section class="screen" data-screen="analyze" hidden={screen.value !== "analyze"}><Header title="Analyze" sub="The deeper pass over your footage — musical/edit-awareness data the Design step uses."/>{snap ? <><div class="op-engine">Engine: runs on your machine (ffmpeg + whisper) — no AI, no cost</div><ol class="op-steps"><li class={`op-step${done ? " done" : ""}`}>Audio events — loudness, onsets, quiet, vocal/instrumental sections</li></ol><div class="row"><button class="btn primary" disabled={analyzeRequest.value !== null} {...ACTIONS.analyzeRun.attrs}>{done ? "Re-run analysis" : "Run analysis"}</button>{analyzeRequest.value !== null ? <button class="btn small" {...ACTIONS.analyzeCancel.attrs}>Cancel</button> : ""}</div>{analyzeStatus.value ? <div class="op-progress"><div class="op-bar" data-indeterminate><div class="op-bar-fill"></div></div><div class="op-status">{analyzeStatus.value}</div></div> : ""}</> : <p class="analyze-empty">Import footage first (New Project) — Analyze needs a project.</p>}</section>; }
function Design(): SafeHtml { return <section class="screen design-screen" data-screen="design" hidden={screen.value !== "design"}><Header title="Design the cut" sub="Describe the cut you want. Continue to Export or open the timeline for detailed multi-camera edits."/><div class="lanes"><div class="lane"><div class="lane-title">Auto</div><p class="lane-desc">Describe the cut and let an AI agent propose it.</p><div class="presets">{each(PRESETS.map(([label, preset]) => ({ label, preset })), (item) => <button class="chip" data-key={item.label} data-preset={item.preset} {...ACTIONS.preset.attrs}>{item.label}</button>)}</div><textarea class="prompt" {...ACTIONS.designPrompt.attrs} rows={3} placeholder="e.g. a punchy 15-second teaser">{designPrompt.value}</textarea><button class="btn primary" disabled={designRunning.value} {...ACTIONS.designMake.attrs}>{autoSessionId ? "Refine cut" : "Make my cut"}</button><div class="lane-note">{designNote.value}</div><ul class="activity-feed">{each(feed.value, (item) => <li class="feed-item" data-key={item.id}><span class="feed-label">{item.label}</span>{item.detail ? <span class="feed-detail">{item.detail}</span> : ""}</li>)}</ul></div><div class="timeline-action"><p class="lane-desc">Need precise multi-camera changes? Open the timeline to adjust angles and split points.</p><button class="btn" {...ACTIONS.timeline.attrs}>Open timeline editor</button><div class="lane-note">{manualNote.value}</div></div></div>{reviewStatus.value ? <div class="review-status">{reviewStatus.value}</div> : ""}{reviewUrl.value ? <iframe class="review-frame" data-morph-skip="" src={reviewUrl.value} title="Review UI"></iframe> : ""}</section>; }
const EXPORTS = [{ kind: "mp4", title: "MP4", desc: "Finished 16:9 video (1280×720)" }, { kind: "social", title: "9:16 Social", desc: "Vertical reel (1080×1920)" }, { kind: "fcpxml", title: "Final Cut Pro", desc: "FCPXML handoff (re-cuttable)" }];
function fmtTime(seconds: number): string { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`; }
function ExportPreview(): SafeHtml {
  const cues = each(audioMap.value, (cue, index) => <li data-key={`${cue.startSeconds}-${cue.kind}-${index}`}><button data-seconds={cue.startSeconds} {...ACTIONS.previewCue.attrs}><time>{fmtTime(cue.startSeconds)}</time><span class={`audio-kind ${cue.kind}`}>{cue.kind}</span><span>{cue.text}</span></button></li>);
  return <div class="export-preview"><h2>Cut preview</h2>{previewUrl.value ? <video id="export-preview-video" data-morph-skip="" src={previewUrl.value} controls preload="metadata"></video> : <div class="preview-status">{previewStatus.value || "Preparing a lightweight preview…"}</div>}{previewStatus.value && !previewUrl.value ? <button class="btn small" {...ACTIONS.retryPreview.attrs}>Retry preview</button> : ""}<h3>Post-edit audio map</h3>{audioMap.value.length ? <ol class="preview-transcript">{cues}</ol> : <p class="sub">No speech/audio analysis is available for this cut yet.</p>}</div>;
}
function ExportScreen(): SafeHtml { return <section class="screen" data-screen="export" hidden={screen.value !== "export"}><Header title="Export" sub="Turn your designed cut into a finished file. Open a project first."/><ExportPreview/><div class="export-cards">{each(EXPORTS.map((item) => ({ ...item })), (item) => { const state = exportsState.value[item.kind] ?? { status: "ready", running: false }; return <div class="export-card" data-key={item.kind} data-kind={item.kind}><div class="export-title">{item.title}</div><div class="export-desc">{item.desc}</div><button class="btn export-run" disabled={state.running} {...ACTIONS.exportRun.attrs}>Export</button>{state.running ? <button class="btn small export-cancel" {...ACTIONS.exportCancel.attrs}>Cancel</button> : ""}<div class="export-status">{state.status}</div>{state.outPath ? <button class="btn small export-reveal" data-path={state.outPath} {...ACTIONS.reveal.attrs}>Reveal in Finder</button> : ""}</div>; })}</div></section>; }
function Permissions(): SafeHtml { const policy = config.value.policy || {}; const rules = config.value.rules || []; return <section class="screen" data-screen="permissions" hidden={screen.value !== "permissions"}><Header title="Permissions" sub="Choose what the AI agent may do silently versus what requires approval."/><ul class="perm-toggles">{each(PERMISSIONS.map(([key,label,desc,def,toggle]) => ({key,label,desc,def,toggle})), (item) => { const allowed = (policy[item.key] ?? item.def) === "allow"; return <li class="perm-toggle" data-key={item.key}><div class="perm-text"><div class="perm-label">{item.label}</div><div class="perm-desc">{item.desc}</div></div><label class="perm-switch"><input type="checkbox" data-category={item.key} checked={allowed} disabled={!item.toggle} {...ACTIONS.policy.attrs}/><span class="perm-state">{allowed ? "allowed" : "asks"}</span></label></li>; })}</ul><h2 class="perm-subhead">Remembered approvals</h2>{rules.length ? <ul class="perm-rules">{each(rules, (rule, index) => <li class="perm-rule" data-key={`${rule.category}-${index}`}><span class="perm-rule-text">{rule.decision === "deny" ? "Never" : "Always"} allow <b>{rule.category}</b> ({rule.scope === "project" ? "this project" : "everywhere"})</span><button class="btn small" data-index={index} {...ACTIONS.revoke.attrs}>Revoke</button></li>)}</ul> : <p class="sub">No remembered rules yet.</p>}{rules.length ? <button class="btn" {...ACTIONS.resetRules.attrs}>Reset all remembered approvals</button> : ""}</section>; }
function InteractionDialog(): SafeHtml { const active = activeInteraction.value; if (!active) return <dialog id="interaction-dialog"></dialog>; const interaction = active.interaction; const questions = interaction.payload?.questions || []; return <dialog id="interaction-dialog"><form method="dialog"><h2>{interaction.kind === "permission" ? interaction.title || "Approval needed" : "The editor needs your input"}</h2><p class="sub">{interaction.kind === "permission" ? interaction.description || "" : "Choose an answer so the cut can continue."}</p>{interaction.kind === "permission" ? <pre class="interaction-detail">{interaction.toolName} · {interaction.category}{"\n"}{JSON.stringify(interaction.input, null, 2)}</pre> : <div class="interaction-questions">{each(questions, (question, index) => <fieldset class="interaction-question" data-key={index}><legend>{question.question || question.header || `Question ${index + 1}`}</legend>{each((question.options || []).map((option) => ({ ...option })), (option) => <label class="interaction-option" data-key={option.label}><input type={question.multiSelect ? "checkbox" : "radio"} name={`question-${index}`} value={option.label}/>{" "}{option.label}{option.description ? <span>{option.description}</span> : ""}</label>)}</fieldset>)}</div>}<div class="interaction-actions">{interaction.kind === "permission" ? <><button class="btn" value="deny" {...ACTIONS.interaction.attrs}>Deny</button><button class="btn" value="always-allow" {...ACTIONS.interaction.attrs}>Always allow this kind</button><button class="btn primary" value="allow-once" {...ACTIONS.interaction.attrs}>Allow once</button></> : <><button class="btn" value="cancelled" {...ACTIONS.interaction.attrs}>Cancel</button><button class="btn primary" value="completed" {...ACTIONS.interaction.attrs}>Continue</button></>}</div></form></dialog>; }
export function DesktopApp(): SafeHtml { return <div class="app" data-ui-runtime="kerfjs"><Rail/><main class="panel"><Setup/><NewProject/><Analyze/><Design/><ExportScreen/><Permissions/></main><InteractionDialog/></div>; }

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
type Listen = (event: string, handler: (event: { payload: string }) => void) => Promise<() => void>;
declare global { interface Window { __TAURI__?: { core: { invoke: Invoke; convertFileSrc?: (path: string) => string }; event: { listen: Listen } } } }
const getTauri = () => { const api = window.__TAURI__; if (!api) throw new Error("Tauri API unavailable"); return api; };
const pending = new Map<number, Handlers>();
const interactionQueue: Array<{ interactionId: string; interaction: Interaction }> = [];
const requestByKind = new Map<string, number>();
let nextId = 1;
function send(step: string, params: Record<string, unknown>, handlers: Handlers = {}): number { const id = nextId++; pending.set(id, handlers); void getTauri().core.invoke("sidecar_send", { payload: JSON.stringify({ type: "request", id, step, params }) }); return id; }
function cancel(id: number): void { void getTauri().core.invoke("sidecar_send", { payload: JSON.stringify({ type: "cancel", id }) }); }
function answerInteraction(interactionId: string, decision: string, value?: unknown): void { void getTauri().core.invoke("sidecar_send", { payload: JSON.stringify({ type: "interaction-response", interactionId, decision, value }) }); }
function showNextInteraction(): void { if (!activeInteraction.value && interactionQueue.length) { activeInteraction.value = interactionQueue.shift() ?? null; queueMicrotask(() => { const dialog = document.getElementById("interaction-dialog") as HTMLDialogElement | null; if (dialog && !dialog.open) dialog.showModal(); }); } }
function applySnapshot(snapshot: ProjectSnapshot): void { if (project.value?.folder !== snapshot.folder) autoSessionId = null; project.value = snapshot; stages.value = snapshot.stages; }
function loadConfig(): void { send("config-get", {}, { onResult: (data: RecentConfig) => { config.value = data; recents.value = data.recentProjects || []; } }); }
function refresh(callback?: () => void): void { const snap = project.value; if (!snap) return; send("project-open", { folder: snap.folder }, { onResult: (data: ProjectSnapshot) => { applySnapshot(data); callback?.(); } }); }
function goto(key: ScreenKey): void { const previous = screen.value; screen.value = key; if (key === "permissions") loadConfig(); if (key === "export" && previous !== "export") { previewFolder = ""; loadExportPreview(); } }
function openFolder(step: string): void { void getTauri().core.invoke("open_folder").then((folder) => { if (typeof folder !== "string" || !folder) return; send(step, { folder }, { onResult: (data: ProjectSnapshot) => { applySnapshot(data); send("config-add-recent", { folder }, { onResult: (next: RecentConfig) => { config.value = next; recents.value = next.recentProjects || []; } }); }, onError: (error) => { importStatus.value = error.message; } }); }); }
function updateExport(kind: string, patch: Partial<ExportState>): void { const current = exportsState.value[kind] ?? { status: "ready", running: false }; exportsState.value = { ...exportsState.value, [kind]: { ...current, ...patch } }; }

function listenSidecar(): void { void getTauri().event.listen("sidecar", (event) => { let message: SidecarMessage; try { message = JSON.parse(event.payload) as SidecarMessage; } catch { return; } if (message.type === "ready") return; if (message.type === "interaction-request" && message.interactionId && message.interaction) { interactionQueue.push({ interactionId: message.interactionId, interaction: message.interaction }); showNextInteraction(); return; } if (message.id === undefined) return; const handlers = pending.get(message.id); if (!handlers) return; if (message.type === "progress" && message.progress) handlers.onProgress?.(message.progress); else if (message.type === "result") { pending.delete(message.id); handlers.onResult?.(message.data as never); } else if (message.type === "error" && message.error) { pending.delete(message.id); handlers.onError?.(message.error); } }); }

export function bootDesktop(root: HTMLElement): void {
  listenSidecar();
  mount(root, DesktopApp);
  void delegate(root, "click", ACTIONS.stage.selector, (_event, el) => { const key = (el as HTMLElement).dataset.stage as StageKey; if (displayState(stages.value.find((item) => item.key === key) ?? defaultStages[0]!, screen.value) !== "locked") goto(key); });
  void delegate(root, "click", ACTIONS.permissions.selector, () => goto("permissions"));
  void delegate(root, "click", ACTIONS.doctor.selector, () => { doctorStatus.value = "Checking…"; doctorRows.value = []; send("doctor", {}, { onResult: (data: { rows: DoctorRow[] }) => { doctorStatus.value = ""; doctorRows.value = data.rows; }, onError: (error) => { doctorStatus.value = `Error: ${error.message}`; } }); });
  void delegate(root, "click", ACTIONS.openProject.selector, () => openFolder("project-open"));
  void delegate(root, "click", ACTIONS.createProject.selector, () => openFolder("project-create"));
  void delegate(root, "click", ACTIONS.recent.selector, (_event, el) => { const folder = (el as HTMLElement).dataset.folder; if (folder) send("project-open", { folder }, { onResult: applySnapshot, onError: (error) => { importStatus.value = error.message; } }); });
  void delegate(root, "click", ACTIONS.importRun.selector, () => { const snap = project.value; if (!snap) return; importStatus.value = "Analyzing footage…"; importRequest.value = send("import-footage", { folder: snap.folder }, { onProgress: (p) => { if (p.message) importStatus.value = `Analyzing… ${p.message}`.slice(0,80); }, onResult: () => { importRequest.value = null; refresh(() => goto("analyze")); }, onError: (error) => { importRequest.value = null; importStatus.value = error.message; } }); });
  void delegate(root, "click", ACTIONS.importCancel.selector, () => { if (importRequest.value !== null) cancel(importRequest.value); });
  void delegate(root, "click", ACTIONS.analyzeRun.selector, () => { const snap = project.value; if (!snap) return; analyzeStatus.value = "Starting…"; analyzeRequest.value = send("analyze-project", { folder: snap.folder }, { onProgress: (p) => { if (p.message) analyzeStatus.value = p.message.slice(0,90); }, onResult: () => { analyzeRequest.value = null; analyzeStatus.value = "Analysis complete."; refresh(() => goto("design")); }, onError: (error) => { analyzeRequest.value = null; analyzeStatus.value = error.message; } }); });
  void delegate(root, "click", ACTIONS.analyzeCancel.selector, () => { if (analyzeRequest.value !== null) cancel(analyzeRequest.value); });
  void delegate(root, "click", ACTIONS.preset.selector, (_event, el) => { designPrompt.value = (el as HTMLElement).dataset.preset || ""; });
  void delegate(root, "input", ACTIONS.designPrompt.selector, (_event, el) => { designPrompt.value = (el as HTMLTextAreaElement).value; });
  void delegate(root, "click", ACTIONS.designMake.selector, () => runDesign());
  void delegate(root, "click", ACTIONS.timeline.selector, () => startReview());
  void delegate(root, "click", ACTIONS.exportRun.selector, (_event, el) => runExport((el as HTMLElement).closest<HTMLElement>("[data-kind]")?.dataset.kind || ""));
  void delegate(root, "click", ACTIONS.exportCancel.selector, (_event, el) => { const kind = (el as HTMLElement).closest<HTMLElement>("[data-kind]")?.dataset.kind; const id = kind ? requestByKind.get(kind) : undefined; if (id !== undefined) cancel(id); });
  void delegate(root, "click", ACTIONS.reveal.selector, (_event, el) => { const path = (el as HTMLElement).dataset.path; if (path) void getTauri().core.invoke("reveal_in_finder", { path }); });
  void delegate(root, "click", ACTIONS.previewCue.selector, (_event, el) => { const video = root.querySelector<HTMLVideoElement>("#export-preview-video"); if (!video) return; video.currentTime = Number((el as HTMLElement).dataset.seconds) || 0; void video.play().catch(() => undefined); });
  void delegate(root, "click", ACTIONS.retryPreview.selector, () => { previewFolder = ""; loadExportPreview(); });
  void delegate(root, "change", ACTIONS.policy.selector, (_event, el) => { const input = el as HTMLInputElement; const category = input.dataset.category; if (category) send("config-set-policy", { category, decision: input.checked ? "allow" : "ask" }, { onResult: (data: RecentConfig) => { config.value = data; } }); });
  void delegate(root, "click", ACTIONS.revoke.selector, (_event, el) => { const index = Number((el as HTMLElement).dataset.index); send("config-revoke-rule", { index }, { onResult: (data: RecentConfig) => { config.value = data; } }); });
  void delegate(root, "click", ACTIONS.resetRules.selector, () => send("config-reset-rules", {}, { onResult: (data: RecentConfig) => { config.value = data; } }));
  void delegate(root, "click", ACTIONS.interaction.selector, (_event, el) => submitInteraction(root, (el as HTMLButtonElement).value));
  void delegate(root, "cancel", "#interaction-dialog", (event) => { event.preventDefault(); submitInteraction(root, "cancelled"); });
  loadConfig();
}

function runDesign(): void { const snap = project.value; const prompt = designPrompt.value.trim(); if (!snap) { designNote.value = "Open a project first (New Project)."; return; } if (!prompt) { designNote.value = "Describe the cut you want (or pick a preset)."; return; } feed.value = []; designRunning.value = true; designNote.value = autoSessionId ? "Refining your cut…" : "Working…"; const params: Record<string, unknown> = { prompt: buildAutoPrompt(prompt, snap), folder: snap.folder }; if (autoSessionId) params.resume = autoSessionId; send("agent-run", params, { onProgress: (p) => { feed.value = [...feed.value, { id: ++feedId, label: p.label || "Working", ...(p.detail ? { detail: p.detail } : {}) }]; }, onResult: (data: { sessionId?: string; landedCut?: boolean }) => { if (data.sessionId) autoSessionId = data.sessionId; if (data.landedCut) { designRunning.value = false; designNote.value = "The AI proposed your cut — opening Export…"; refresh(() => goto("export")); return; } send("design-cut", { folder: snap.folder, kind: cutKindFromPrompt(prompt) }, { onResult: () => { designRunning.value = false; refresh(() => goto("export")); }, onError: (error) => { designRunning.value = false; designNote.value = error.message; } }); }, onError: (error) => { designRunning.value = false; designNote.value = error.code === "not_connected" ? "Claude isn't connected." : error.message; } }); }
function startReview(): void { const snap = project.value; if (!snap) { manualNote.value = "Open a project first (New Project)."; return; } const artifacts = snap.project.artifacts; if (artifacts.includes("cut") && !artifacts.includes("switches")) { manualNote.value = "Timeline editing currently supports multi-camera projects. Your cut is ready to Export."; return; } const launch = () => { reviewStatus.value = "Starting the review UI…"; send("review-start", { folder: project.value?.folder || snap.folder }, { onResult: (data: { url: string }) => { reviewUrl.value = data.url; reviewStatus.value = ""; }, onError: (error) => { reviewStatus.value = error.message; } }); }; if (artifacts.includes("switches")) launch(); else { manualNote.value = "Proposing an auto starting cut…"; send("design-cut", { folder: snap.folder }, { onResult: () => refresh(launch), onError: (error) => { manualNote.value = error.message; } }); } }
function loadExportPreview(): void {
  const snap = project.value;
  if (!snap || previewFolder === snap.folder) return;
  previewFolder = snap.folder; previewUrl.value = ""; audioMap.value = []; previewStatus.value = "Rendering a lightweight preview…";
  send("export-preview", { folder: snap.folder }, {
    onProgress: (progress) => { if (progress.message) previewStatus.value = progress.message.slice(0, 90); },
    onResult: (data: { outPath: string; audioMap?: AudioMapCue[] }) => { const convert = getTauri().core.convertFileSrc; previewUrl.value = convert ? convert(data.outPath) : data.outPath; audioMap.value = data.audioMap || []; previewStatus.value = ""; },
    onError: (error) => { previewFolder = ""; previewStatus.value = `Preview unavailable: ${error.message}`; },
  });
}

function runExport(kind: string): void { const snap = project.value; if (!snap || !kind) { if (kind) updateExport(kind, { status: "open a project first" }); return; } updateExport(kind, { status: "rendering…", running: true, outPath: undefined }); const id = send(`export-${kind}`, { folder: snap.folder }, { onProgress: (p) => updateExport(kind, { status: p.message ? `rendering… ${p.message}`.slice(0,60) : "rendering…" }), onResult: (data: { outPath: string }) => { requestByKind.delete(kind); updateExport(kind, { status: "done", running: false, outPath: data.outPath }); }, onError: (error) => { requestByKind.delete(kind); updateExport(kind, { status: `error: ${error.message}`, running: false }); } }); requestByKind.set(kind, id); }
function submitInteraction(root: HTMLElement, decision: string): void { const active = activeInteraction.value; if (!active) return; (root.querySelector("#interaction-dialog") as HTMLDialogElement | null)?.close(); let value: unknown; if (active.interaction.kind === "question" && decision === "completed") { const questions = active.interaction.payload?.questions || []; const answers: Record<string,string> = {}; questions.forEach((question,index) => { answers[question.question] = [...root.querySelectorAll<HTMLInputElement>(`[name="question-${index}"]:checked`)].map((input) => input.value).join(", "); }); value = { questions, answers }; } answerInteraction(active.interactionId, decision, value); activeInteraction.value = null; showNextInteraction(); }

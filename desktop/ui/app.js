// video-studio desktop frontend (VS-76). Vanilla JS over the global Tauri API
// (withGlobalTauri). It talks to the Node sidecar via two primitives:
//   - invoke("sidecar_send", { payload }) — send one NDJSON protocol request
//   - event.listen("sidecar", ...)        — receive each NDJSON response line
// Protocol shapes live in desktop/sidecar/protocol.mjs (the pure, tested source).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The pipeline stages (R-APP5). `locked` stages aren't wired yet (R-APP6) — the
// spike ships Setup + Analyze; the rest are shown locked, not as placeholders.
const STAGES = [
  { key: "setup", label: "Setup", locked: false },
  { key: "new-project", label: "New Project", locked: true },
  { key: "analyze", label: "Analyze", locked: false },
  { key: "design", label: "Design", locked: true },
  { key: "review", label: "Review", locked: true },
  { key: "export", label: "Export", locked: true },
];

let activeStage = "setup";
let nextId = 1;
const pending = new Map(); // request id -> { onProgress, onResult, onError }

function send(step, params, handlers) {
  const id = nextId++;
  pending.set(id, handlers || {});
  invoke("sidecar_send", { payload: JSON.stringify({ type: "request", id, step, params: params || {} }) });
  return id;
}

// Route each NDJSON line from the sidecar to its request's handlers.
listen("sidecar", (event) => {
  let msg;
  try {
    msg = JSON.parse(event.payload);
  } catch {
    return;
  }
  if (msg.type === "ready") return;
  const h = pending.get(msg.id);
  if (!h) return;
  if (msg.type === "progress") h.onProgress && h.onProgress(msg.progress);
  else if (msg.type === "result") {
    pending.delete(msg.id);
    h.onResult && h.onResult(msg.data);
  } else if (msg.type === "error") {
    pending.delete(msg.id);
    h.onError && h.onError(msg.error);
  }
});

// --- stage rail -----------------------------------------------------------

function renderRail() {
  const rail = document.getElementById("rail");
  rail.innerHTML = "";
  for (const stage of STAGES) {
    const el = document.createElement("button");
    el.className = "stage";
    el.textContent = stage.label;
    el.dataset.state = stage.locked ? "locked" : stage.key === activeStage ? "active" : "idle";
    el.disabled = stage.locked;
    el.addEventListener("click", () => {
      if (stage.locked) return;
      activeStage = stage.key;
      renderRail();
      showScreen(stage.key);
    });
    rail.appendChild(el);
  }
}

function showScreen(key) {
  for (const s of document.querySelectorAll(".screen")) {
    s.hidden = s.dataset.screen !== key;
  }
}

// --- Setup / doctor -------------------------------------------------------

function renderDoctor(result) {
  const list = document.getElementById("doctor-rows");
  list.innerHTML = "";
  for (const row of result.rows) {
    const li = document.createElement("li");
    li.className = `doctor-row ${row.status}`;
    const dot = row.found ? "●" : "○";
    const req = row.required ? "required" : "optional";
    li.innerHTML =
      `<span class="dot">${dot}</span>` +
      `<span class="name">${row.label}</span>` +
      `<span class="tag">${req}</span>` +
      (row.found ? "" : `<span class="hint">${row.hint}</span>`);
    list.appendChild(li);
  }
}

document.getElementById("run-doctor").addEventListener("click", () => {
  document.getElementById("doctor-rows").innerHTML = "<li class='doctor-row'>Checking…</li>";
  send("doctor", {}, {
    onResult: renderDoctor,
    onError: (e) => {
      document.getElementById("doctor-rows").innerHTML = `<li class='doctor-row missing-required'>Error: ${e.message}</li>`;
    },
  });
});

// --- Analyze --------------------------------------------------------------

let selectedVideo = null;

document.getElementById("open-video").addEventListener("click", async () => {
  const path = await invoke("open_video");
  if (!path) return;
  selectedVideo = path;
  document.getElementById("video-path").textContent = path;
  document.getElementById("run-analyze").disabled = false;
});

document.getElementById("run-analyze").addEventListener("click", () => {
  if (!selectedVideo) return;
  const log = document.getElementById("analyze-log");
  const progress = document.getElementById("analyze-progress");
  const bar = document.getElementById("analyze-bar");
  const stageLabel = document.getElementById("analyze-stage");
  log.textContent = "";
  progress.hidden = false;
  bar.style.width = "0%";
  document.getElementById("run-analyze").disabled = true;

  let total = 0;
  send("analyze-scenes", { video: selectedVideo }, {
    onProgress: (p) => {
      log.textContent += `${p.message || p.stage}\n`;
      log.scrollTop = log.scrollHeight;
      stageLabel.textContent = p.stage;
      if (p.stage === "detected" || p.stage === "resume") total = p.total || 0;
      if (p.stage === "describe" && total) bar.style.width = `${Math.round((p.current / total) * 100)}%`;
    },
    onResult: () => {
      bar.style.width = "100%";
      stageLabel.textContent = "done";
      document.getElementById("run-analyze").disabled = false;
    },
    onError: (e) => {
      stageLabel.textContent = `error: ${e.message}`;
      document.getElementById("run-analyze").disabled = false;
    },
  });
});

// --- boot -----------------------------------------------------------------

renderRail();
showScreen("setup");

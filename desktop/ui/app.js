// video-studio desktop frontend (VS-76). Vanilla JS over the global Tauri API
// (withGlobalTauri). It talks to the Node sidecar via two primitives:
//   - invoke("sidecar_send", { payload }) — send one NDJSON protocol request
//   - event.listen("sidecar", ...)        — receive each NDJSON response line
// Protocol shapes live in desktop/sidecar/protocol.mjs (the pure, tested source).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// The pipeline stage rail (R-APP5/6). State (key/label/state) is sourced from the
// sidecar's pure deriveStages once a project is open, else this no-project default
// (which matches deriveStages([])): Setup + New Project reachable, the rest locked.
let railStages = [
  { key: "setup", label: "Setup", state: "active" },
  { key: "new-project", label: "New Project", state: "idle" },
  { key: "analyze", label: "Analyze", state: "locked" },
  { key: "design", label: "Design", state: "locked" },
  { key: "review", label: "Review", state: "locked" },
  { key: "export", label: "Export", state: "locked" },
];
let selectedStage = "setup";
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

// Map a stage's underlying (sidecar-derived) state + the current selection to the
// rail's display state: locked wins; the selected stage is active; done stays done;
// everything else is idle.
function displayState(stage) {
  if (stage.state === "locked") return "locked";
  if (stage.key === selectedStage) return "active";
  if (stage.state === "done") return "done";
  return "idle";
}

function renderRail() {
  const rail = document.getElementById("rail");
  rail.innerHTML = "";
  for (const stage of railStages) {
    const state = displayState(stage);
    const el = document.createElement("button");
    el.className = "stage";
    el.textContent = stage.label;
    el.dataset.state = state;
    el.disabled = state === "locked";
    el.addEventListener("click", () => {
      if (state === "locked") return;
      selectedStage = stage.key;
      renderRail();
      showScreen(stage.key);
      onEnterScreen(stage.key);
    });
    rail.appendChild(el);
  }
}

let currentProject = null;

// Apply a project snapshot from the sidecar (project-open / project-create result).
function applyProjectSnapshot(snapshot) {
  currentProject = snapshot;
  railStages = snapshot.stages;
  renderRail();
  const info = document.getElementById("project-info");
  info.hidden = false;
  document.getElementById("project-name").textContent = snapshot.project.name;
  document.getElementById("project-folder").textContent = snapshot.folder;
  const list = document.getElementById("project-artifacts");
  list.innerHTML = "";
  for (const a of snapshot.project.artifacts) {
    const li = document.createElement("li");
    li.className = "artifact";
    li.textContent = a;
    list.appendChild(li);
  }

  // Has the footage been imported yet? (sources.json single-source, or multicam.json).
  const imported =
    snapshot.project.artifacts.includes("sources") || snapshot.project.artifacts.includes("multicam");
  const importBox = document.getElementById("import-box");
  importBox.hidden = imported;
  if (!imported) {
    list.innerHTML = "<li class='artifact none'>No footage imported yet. Analyze this folder's video(s) to begin — that detects single vs multi-cam and unlocks the pipeline.</li>";
    document.getElementById("import-status").textContent = "";
  }
}

// Import: turn the opened folder's raw footage into the first artifact (sources/multicam.json),
// then refresh so the rail unlocks. This can take a while (audio sync / scene analysis).
document.getElementById("import-run").addEventListener("click", () => {
  if (!currentProject) return;
  const btn = document.getElementById("import-run");
  const status = document.getElementById("import-status");
  btn.disabled = true;
  status.textContent = "Analyzing footage… (this can take a while)";
  send("import-footage", { folder: currentProject.folder }, {
    onProgress: (p) => {
      if (p.message) status.textContent = `Analyzing… ${p.message}`.slice(0, 80);
    },
    onResult: (data) => {
      status.textContent = data.kind === "multicam" ? `Synced ${data.count} angles.` : "Analyzed single source.";
      send("project-open", { folder: currentProject.folder }, { onResult: applyProjectSnapshot });
    },
    onError: (e) => {
      btn.disabled = false;
      status.textContent = e.message;
    },
  });
});

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

// --- New Project ----------------------------------------------------------

async function openOrCreateProject(step) {
  const folder = await invoke("open_folder");
  if (!folder) return;
  send(step, { folder }, {
    onResult: applyProjectSnapshot,
    onError: (e) => {
      document.getElementById("project-info").hidden = false;
      document.getElementById("project-name").textContent = `Error: ${e.message}`;
      document.getElementById("project-folder").textContent = "";
      document.getElementById("project-artifacts").innerHTML = "";
    },
  });
}

document.getElementById("open-project").addEventListener("click", () => openOrCreateProject("project-open"));
document.getElementById("create-project").addEventListener("click", () => openOrCreateProject("project-create"));

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

// --- Design (two lanes) ---------------------------------------------------

// Auto lane: presets fill the prompt.
for (const chip of document.querySelectorAll("#design-presets .chip")) {
  chip.addEventListener("click", () => {
    document.getElementById("design-prompt").value = chip.dataset.preset;
  });
}

// Auto lane "Make my cut" — drive the live AI agent (VS-91) with the prompt + project
// context, streaming its activity into a feed. The agent proposes; Review refines (R-DS4).
document.getElementById("design-make").addEventListener("click", () => {
  const note = document.getElementById("design-auto-note");
  const feed = document.getElementById("design-feed");
  const prompt = document.getElementById("design-prompt").value.trim();
  if (!currentProject) {
    note.textContent = "Open a project first (New Project).";
    return;
  }
  if (!prompt) {
    note.textContent = "Describe the cut you want (or pick a preset).";
    return;
  }
  feed.innerHTML = "";
  note.textContent = "Working…";
  const btn = document.getElementById("design-make");
  btn.disabled = true;
  const addFeed = (label, detail) => {
    const li = document.createElement("li");
    li.className = "feed-item";
    li.innerHTML = `<span class="feed-label">${label}</span>${detail ? `<span class="feed-detail">${detail}</span>` : ""}`;
    feed.appendChild(li);
    feed.scrollTop = feed.scrollHeight;
  };
  send("agent-run", { prompt: `${prompt}\n\n(Project folder: ${currentProject.folder})`, folder: currentProject.folder }, {
    onProgress: (p) => addFeed(p.label, p.detail),
    onResult: () => {
      btn.disabled = false;
      note.textContent = "Done. Open the timeline to review + refine the cut.";
    },
    onError: (e) => {
      btn.disabled = false;
      note.textContent = e.code === "not_connected" ? "Claude isn't connected. Add your API key / sign in (setup coming)." : e.message;
    },
  });
});

// Manual lane: open the timeline. If there's no cut yet, propose an auto starting point
// (propose-switches) first, then jump to Review.
document.getElementById("design-open-timeline").addEventListener("click", () => {
  const note = document.getElementById("design-manual-note");
  if (!currentProject) {
    note.textContent = "Open a project first (New Project).";
    return;
  }
  const hasCut = currentProject.project.artifacts.includes("switches");
  if (hasCut) {
    gotoReview();
    return;
  }
  note.textContent = "Proposing an auto starting cut…";
  send("design-cut", { folder: currentProject.folder }, {
    onProgress: (p) => {
      if (p.message) note.textContent = `Proposing… ${p.message}`.slice(0, 70);
    },
    onResult: () => {
      note.textContent = "Cut ready — opening the timeline.";
      // Refresh the project so the rail + artifacts pick up switches.json, then review.
      send("project-open", { folder: currentProject.folder }, {
        onResult: (snap) => {
          applyProjectSnapshot(snap);
          gotoReview();
        },
      });
    },
    onError: (e) => {
      note.textContent = e.message;
    },
  });
});

function gotoReview() {
  selectedStage = "review";
  renderRail();
  showScreen("review");
  startReview();
}

// --- Review ---------------------------------------------------------------

// Start (or reuse) the review server for the current project and point the iframe at it.
function startReview() {
  const status = document.getElementById("review-status");
  const frame = document.getElementById("review-frame");
  if (!currentProject) {
    status.hidden = false;
    frame.hidden = true;
    status.textContent = "Open a project first (New Project).";
    return;
  }
  status.hidden = false;
  status.textContent = "Starting the review UI…";
  frame.hidden = true;
  send("review-start", { folder: currentProject.folder }, {
    onResult: (data) => {
      frame.src = data.url;
      frame.hidden = false;
      status.hidden = true;
    },
    onError: (e) => {
      status.hidden = false;
      status.textContent = e.message;
    },
  });
}

// Per-screen entry hook (currently only Review needs one).
function onEnterScreen(key) {
  if (key === "review") startReview();
}

// --- Export ---------------------------------------------------------------

for (const card of document.querySelectorAll(".export-card")) {
  const kind = card.dataset.kind;
  const status = card.querySelector("[data-status]");
  const runBtn = card.querySelector(".export-run");
  const revealBtn = card.querySelector(".export-reveal");

  runBtn.addEventListener("click", () => {
    if (!currentProject) {
      status.textContent = "open a project first";
      return;
    }
    runBtn.disabled = true;
    revealBtn.hidden = true;
    status.textContent = "rendering…";
    send(`export-${kind}`, { folder: currentProject.folder }, {
      onProgress: (p) => {
        status.textContent = p.message ? `rendering… ${p.message}`.slice(0, 60) : "rendering…";
      },
      onResult: (data) => {
        runBtn.disabled = false;
        status.textContent = "done";
        revealBtn.hidden = false;
        revealBtn.onclick = () => invoke("reveal_in_finder", { path: data.outPath });
      },
      onError: (e) => {
        runBtn.disabled = false;
        status.textContent = `error: ${e.message}`;
      },
    });
  });
}

// --- Permissions (app settings) -------------------------------------------

// Category metadata for the toggles. `def` mirrors permissions.mjs DEFAULT_POLICY;
// `toggle:false` categories are shown but always ask (safety).
const PERM_CATEGORIES = [
  { key: "media-processing", label: "Process video", desc: "ffmpeg / whisper / our pipeline tools", def: "allow", toggle: true },
  { key: "read-in-project", label: "Read this project", desc: "read files inside the project folder", def: "allow", toggle: true },
  { key: "write-in-project", label: "Write results here", desc: "write outputs into the project folder", def: "allow", toggle: true },
  { key: "network-egress", label: "Access the network", desc: "anything beyond local Ollama + the agent API", def: "ask", toggle: true },
  { key: "other-shell", label: "Run other commands", desc: "shell that isn't recognized", def: "ask", toggle: true },
  { key: "destructive", label: "Delete / write outside the project", desc: "always asks, for your safety", def: "ask", toggle: false },
];
const PERM_LABELS = Object.fromEntries(PERM_CATEGORIES.map((c) => [c.key, c.label]));

function effectiveDecision(cat, policy) {
  return policy[cat.key] ?? cat.def;
}

function renderPermissions(config) {
  const policy = config.policy || {};
  const toggles = document.getElementById("perm-toggles");
  toggles.innerHTML = "";
  for (const cat of PERM_CATEGORIES) {
    const allowed = effectiveDecision(cat, policy) === "allow";
    const li = document.createElement("li");
    li.className = "perm-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = allowed;
    cb.disabled = !cat.toggle;
    cb.addEventListener("change", () => {
      send("config-set-policy", { category: cat.key, decision: cb.checked ? "allow" : "ask" }, { onResult: renderPermissions });
    });
    const text = document.createElement("div");
    text.className = "perm-text";
    text.innerHTML = `<div class="perm-label">${cat.label}</div><div class="perm-desc">${cat.desc}</div>`;
    const state = document.createElement("span");
    state.className = "perm-state";
    state.textContent = allowed ? "allowed" : "asks";
    const label = document.createElement("label");
    label.className = "perm-switch";
    label.append(cb, state);
    li.append(text, label);
    toggles.appendChild(li);
  }

  const rules = config.rules || [];
  const list = document.getElementById("perm-rules");
  list.innerHTML = "";
  document.getElementById("perm-rules-empty").hidden = rules.length > 0;
  document.getElementById("perm-reset").hidden = rules.length === 0;
  rules.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "perm-rule";
    const scope = r.scope === "project" ? "this project" : "everywhere";
    li.innerHTML = `<span class="perm-rule-text">${r.decision === "deny" ? "Never" : "Always"} allow <b>${PERM_LABELS[r.category] || r.category}</b> (${scope})</span>`;
    const revoke = document.createElement("button");
    revoke.className = "btn small";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", () => send("config-revoke-rule", { index: i }, { onResult: renderPermissions }));
    li.appendChild(revoke);
    list.appendChild(li);
  });
}

function loadPermissions() {
  send("config-get", {}, { onResult: renderPermissions });
}

document.getElementById("perm-reset").addEventListener("click", () => {
  send("config-reset-rules", {}, { onResult: renderPermissions });
});
document.getElementById("open-permissions").addEventListener("click", () => {
  selectedStage = null;
  renderRail();
  showScreen("permissions");
  loadPermissions();
});

// --- boot -----------------------------------------------------------------

renderRail();
showScreen("setup");

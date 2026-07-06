#!/usr/bin/env node
// Sidecar host (I/O edge, R-APP11) — the long-lived Node process the Tauri (Rust)
// shell spawns once and drives over stdio. It owns the actual stdin reading and
// child-process spawning; all message shaping + validation + step descriptors are
// the PURE modules protocol.mjs / steps.mjs (unit-tested to 100%). This file is the
// unavoidable orchestration edge, exercised via docs/manual-test-plan.md, not vitest.
//
// Protocol: newline-delimited JSON in/out (see protocol.mjs). One request → a stream
// of `progress` frames → a terminal `result` or `error`. `cancel` kills an in-flight
// child. The host stays up across many requests (one per pipeline step the UI runs).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ERROR_CODES,
  frameMessage,
  parseFrames,
  readyMessage,
  progressMessage,
  resultMessage,
  errorMessage,
  validateRequest,
  MESSAGE_TYPES,
} from "./protocol.mjs";
import {
  STEP_REGISTRY,
  toolArgv,
  exportCommand,
  genericProgress,
  reviewCommand,
  parseReviewUrl,
  proposeCommand,
  importCommand,
  analyzeProjectCommand,
} from "./steps.mjs";
import { proposeCutSpec, flatRenderCommand, cutPlanToCutSpec } from "./cutspec.mjs";
import { DOCTOR_TOOLS, doctorResultFromChecks } from "./doctor.mjs";
import {
  PROJECT_STATE_DIR,
  PROJECT_STATE_FILE,
  deriveStages,
  newProjectState,
  reconcileProject,
} from "./project.mjs";
import {
  parseConfig,
  serializeConfig,
  addRecentProject,
  addRule,
  revokeRule,
  resetRules,
  setCategoryPolicy,
} from "./config.mjs";
import {
  normalizeClaudeEvent,
  eventToFeedEntry,
  isAuthFailure,
  AGENT_EVENT_KINDS,
  extractCutPlan,
  validateCutPlan,
  validateSingleSourceCutPlan,
  cutPlanToSwitches,
  unknownPlanMembers,
} from "./agent.mjs";
import { decide, isInProject } from "./permissions.mjs";
import { buildOllamaMessages, parseModelReply, nextLoopAction, toolResultMessage } from "./ollama-backend.mjs";
import { codexExecArgv, normalizeCodexEvent, CODEX_CUTPLAN_SCHEMA } from "./codex-backend.mjs";

// The repo root is two levels up from desktop/sidecar/. The app lives in a subdir
// of this repo (settled), so the pipeline tools sit alongside at ../../.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const inflight = new Map(); // id -> ChildProcess

function send(obj) {
  process.stdout.write(frameMessage(obj));
}

// Spawn a pipeline tool in its OWN process group (detached) so a cancel can tear down the
// whole tree — the tool typically spawns ffmpeg/whisper/the analyzer, and signalling only the
// direct child would orphan those. Not unref'd: we still want its stdio + close event.
function spawnTool(cmd, args) {
  return spawn(cmd, args, { cwd: REPO_ROOT, detached: true });
}

// Terminate a child and its descendants by signalling its process group (negative pid).
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  }
}

function runStep({ id, step, params }) {
  const descriptor = STEP_REGISTRY[step];
  const { tool, args } = descriptor.buildCommand(params);
  const [cmd, entry] = toolArgv(tool, REPO_ROOT);
  const child = spawnTool(cmd, [entry, ...args]);
  inflight.set(id, child);

  // Split each stream into lines and run the step's progress parser over each.
  const feed = (stream) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const p = descriptor.parseProgress(line);
        if (p) send(progressMessage(id, p));
      }
    });
  };
  feed(child.stdout);
  feed(child.stderr);

  child.on("error", (err) => {
    inflight.delete(id);
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, String(err && err.message ? err.message : err)));
  });
  child.on("close", (code, signal) => {
    inflight.delete(id);
    if (signal) {
      send(errorMessage(id, ERROR_CODES.STEP_FAILED, `cancelled (${signal})`));
    } else if (code === 0) {
      send(resultMessage(id, { step, ok: true }));
    } else {
      send(errorMessage(id, ERROR_CODES.STEP_FAILED, `${step} exited with code ${code}`));
    }
  });
}

// Doctor is not a single-tool spawn — it probes each dependency with `which` and
// summarizes via the pure doctorResultFromChecks. It sidesteps the step registry.
function runDoctor(id) {
  const found = {};
  let pending = DOCTOR_TOOLS.length;
  const finish = () => {
    if (--pending === 0) send(resultMessage(id, doctorResultFromChecks(found)));
  };
  for (const tool of DOCTOR_TOOLS) {
    const probe = spawn("which", [tool.key]);
    probe.on("error", () => {
      found[tool.key] = false;
      finish();
    });
    probe.on("close", (code) => {
      found[tool.key] = code === 0;
      finish();
    });
  }
}

// Project steps read/write the filesystem (the I/O edge) around the pure project
// model in project.mjs. `project-open` re-derives artifacts + stage state from what's
// actually on disk (filesystem wins); `project-create` writes a fresh state file.
function readProjectState(folder) {
  try {
    const raw = fs.readFileSync(path.join(folder, PROJECT_STATE_DIR, PROJECT_STATE_FILE), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function projectSnapshot(folder, project) {
  // project.artifacts is a list of artifact *keys*; deriveStages takes a Set of keys
  // (an array would be treated as raw filenames).
  return { folder, project, stages: deriveStages(new Set(project.artifacts)) };
}

function runProjectOpen(id, folder) {
  let entries = [];
  try {
    entries = fs.readdirSync(folder);
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `cannot open ${folder}: ${err.message}`));
    return;
  }
  const project = reconcileProject(readProjectState(folder), entries, path.basename(folder));
  send(resultMessage(id, projectSnapshot(folder, project)));
}

function runProjectCreate(id, folder, name) {
  try {
    fs.mkdirSync(path.join(folder, PROJECT_STATE_DIR), { recursive: true });
    const project = newProjectState(name || path.basename(folder));
    fs.writeFileSync(
      path.join(folder, PROJECT_STATE_DIR, PROJECT_STATE_FILE),
      JSON.stringify(project, null, 2),
    );
    send(resultMessage(id, projectSnapshot(folder, project)));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `cannot create project in ${folder}: ${err.message}`));
  }
}

// The app-global config lives under the user's Application Support dir (macOS), separate
// from any project folder + from any agent's own settings (R-APP18). These are the I/O edge
// around the pure transforms in config.mjs.
const CONFIG_PATH = path.join(os.homedir(), "Library", "Application Support", "video-studio", "config.json");

function loadConfig() {
  try {
    return parseConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return parseConfig(null); // missing/corrupt → defaults
  }
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, serializeConfig(config));
  return config;
}

// Apply a pure config transform, persist, and return the new config to the UI.
function runConfig(id, transform) {
  try {
    send(resultMessage(id, saveConfig(transform(loadConfig()))));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `config error: ${err.message}`));
  }
}

// Route a `config-*` step to its pure transform (or a read). Returns true if handled.
function handleConfigStep(id, step, params) {
  switch (step) {
    case "config-get":
      send(resultMessage(id, loadConfig()));
      return true;
    case "config-add-recent":
      runConfig(id, (c) => addRecentProject(c, params.folder));
      return true;
    case "config-add-rule":
      runConfig(id, (c) => addRule(c, params.rule));
      return true;
    case "config-revoke-rule":
      runConfig(id, (c) => revokeRule(c, params.index));
      return true;
    case "config-reset-rules":
      runConfig(id, (c) => resetRules(c));
      return true;
    case "config-set-policy":
      runConfig(id, (c) => setCategoryPolicy(c, params.category, params.decision));
      return true;
    default:
      return false;
  }
}

// Export steps (R-EX) reuse the shipped exporters over the project folder. The output path
// + argv come from the pure exportCommand; the host creates exports/, includes the reviewed
// cut only when switches.json exists, streams the tool's output, and returns the out path so
// the UI can Reveal it in Finder.
function runExport(id, kind, folder) {
  // Single-source projects (a cut.json, no multicam.json) export via a flat ffmpeg render /
  // export-project handoff, not the multi-cam renderer (VS-99).
  if (!fs.existsSync(path.join(folder, "multicam.json")) && fs.existsSync(path.join(folder, "cut.json"))) {
    runExportSingle(id, kind, folder);
    return;
  }
  let command;
  try {
    const hasSwitches = fs.existsSync(path.join(folder, "switches.json"));
    command = exportCommand(kind, folder, { hasSwitches });
    fs.mkdirSync(path.dirname(command.outPath), { recursive: true });
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `export setup failed: ${err.message}`));
    return;
  }
  runToolCommand(id, command, { kind, outPath: command.outPath });
}

// Single-source export (VS-99): mp4 / 9:16 are a flat ffmpeg render of the cut spec; fcpxml
// is the export-project editor handoff. The cut spec is the project's cut.json.
function runExportSingle(id, kind, folder) {
  const exportsDir = path.join(folder, "exports");
  fs.mkdirSync(exportsDir, { recursive: true });
  if (kind === "fcpxml") {
    const outDir = path.join(exportsDir, "handoff");
    runToolCommand(
      id,
      { tool: "export-project", args: [path.join(folder, "cut.json"), "--out", outDir] },
      { kind, outPath: outDir },
    );
    return;
  }
  let render;
  try {
    const cut = JSON.parse(fs.readFileSync(path.join(folder, "cut.json"), "utf8"));
    const dims = kind === "social" ? { width: 1080, height: 1920 } : {};
    const outName = kind === "social" ? "cut.9x16.mp4" : "cut.mp4";
    render = flatRenderCommand(cut, path.join(exportsDir, outName), dims);
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `export failed: ${err.message}`));
    return;
  }
  runToolCommand(id, { bin: "ffmpeg", args: render.args }, { kind, outPath: render.outPath });
}

const EXPORT_STEPS = { "export-mp4": "mp4", "export-social": "social", "export-fcpxml": "fcpxml" };

// Stream a one-shot tool command (like export/propose): spawn, forward output as progress,
// return { ...extra, ok } on success. Shared by the export + design-cut steps.
function runToolCommand(id, command, extra) {
  // `command.bin` runs a non-Node binary directly (e.g. ffmpeg); otherwise resolve a Node
  // tool via toolArgv.
  const child = command.bin
    ? spawnTool(command.bin, command.args)
    : (() => {
        const [cmd, entry] = toolArgv(command.tool, REPO_ROOT);
        return spawnTool(cmd, [entry, ...command.args]);
      })();
  inflight.set(id, child);
  const feed = (stream) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        const p = genericProgress(line);
        if (p) send(progressMessage(id, p));
      }
    });
  };
  feed(child.stdout);
  feed(child.stderr);
  child.on("error", (err) => {
    inflight.delete(id);
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, String(err && err.message ? err.message : err)));
  });
  child.on("close", (code, signal) => {
    inflight.delete(id);
    if (signal) send(errorMessage(id, ERROR_CODES.STEP_FAILED, `cancelled (${signal})`));
    else if (code === 0) send(resultMessage(id, { ...extra, ok: true }));
    else send(errorMessage(id, ERROR_CODES.STEP_FAILED, `${command.tool || command.bin} exited with code ${code}`));
  });
}

// New Project import (VS-81): turn a folder of raw footage into the project's first artifact —
// one video → sources.json (analyze-sources); 2+ → multicam.json (audio-sync). This is what
// unlocks the rest of the rail. The pure importCommand picks the tool; the host does readdir.
function runImportFootage(id, folder) {
  let command;
  try {
    command = importCommand(folder, fs.readdirSync(folder));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, err.message));
    return;
  }
  runToolCommand(id, command, { outPath: command.outPath, kind: command.kind, count: command.count });
}

// The Analyze stage (VS-82): the deeper audio-events pass over the project's footage —
// distinct from import's scene detection; produces audio-events.json for Design.
function runAnalyzeProject(id, folder) {
  let command;
  try {
    command = analyzeProjectCommand(folder, fs.readdirSync(folder));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, err.message));
    return;
  }
  runToolCommand(id, command, { outPath: command.outPath });
}

// Propose a cut (R-DS2). Multi-cam → propose-switches → switches.json (angle cut). Single
// source → proposeCutSpec → cut.json (scene-range cut spec, VS-99). `kind` names the style.
function runDesignCut(id, folder, kind) {
  if (fs.existsSync(path.join(folder, "multicam.json"))) {
    const command = proposeCommand(folder, {
      hasAudioEvents: fs.existsSync(path.join(folder, "audio-events.json")),
      hasSaliency: fs.existsSync(path.join(folder, "saliency.json")),
    });
    runToolCommand(id, command, { outPath: command.outPath, kind: "multicam" });
    return;
  }
  // Single-source: proposeCutSpec is pure — read sources.json (+ audio-events.json when
  // present, for loudness/onset-aware selection), write cut.json (no child process).
  try {
    const sources = JSON.parse(fs.readFileSync(path.join(folder, "sources.json"), "utf8"));
    let audioEvents = null;
    try {
      audioEvents = JSON.parse(fs.readFileSync(path.join(folder, "audio-events.json"), "utf8"));
    } catch {
      audioEvents = null; // optional — falls back to spread selection
    }
    const spec = proposeCutSpec(sources, { kind: kind || "highlights" }, audioEvents);
    fs.writeFileSync(path.join(folder, "cut.json"), JSON.stringify(spec, null, 2));
    send(resultMessage(id, { outPath: path.join(folder, "cut.json"), kind: "single", clips: spec.clips.length }));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `design failed: ${err.message}`));
  }
}

// The review UI is a long-lived local server (tools/review-switches.mjs) the webview iframes
// (R-RV1). It lives OUTSIDE `inflight` — it must survive across requests until review-stop or
// host exit, not be killed by the per-request close handler.
let reviewServer = null; // { child, url }

function runReviewStart(id, folder) {
  if (reviewServer) {
    send(resultMessage(id, { url: reviewServer.url }));
    return;
  }
  if (!fs.existsSync(path.join(folder, "switches.json")) || !fs.existsSync(path.join(folder, "multicam.json"))) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, "review needs multicam.json + a reviewed cut (switches.json)"));
    return;
  }
  const { tool, args } = reviewCommand(folder, {
    hasAudioEvents: fs.existsSync(path.join(folder, "audio-events.json")),
    hasSaliency: fs.existsSync(path.join(folder, "saliency.json")),
  });
  const [cmd, entry] = toolArgv(tool, REPO_ROOT);
  const child = spawnTool(cmd, [entry, ...args]);
  let answered = false;

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const url = parseReviewUrl(line);
      if (url && !answered) {
        answered = true;
        reviewServer = { child, url };
        send(resultMessage(id, { url }));
      }
    }
  });
  child.on("error", (err) => {
    if (!answered) {
      answered = true;
      send(errorMessage(id, ERROR_CODES.STEP_FAILED, `review server failed: ${err.message}`));
    }
  });
  child.on("close", (code) => {
    if (reviewServer && reviewServer.child === child) reviewServer = null;
    if (!answered) {
      answered = true;
      send(errorMessage(id, ERROR_CODES.STEP_FAILED, `review server exited (code ${code}) before it was ready`));
    }
  });
}

function runReviewStop(id) {
  if (reviewServer) {
    killTree(reviewServer.child);
    reviewServer = null;
  }
  send(resultMessage(id, { stopped: true }));
}

// Land a structured cut plan (R-CB7): translate the agent's plan into the SAME artifact the
// Manual lane produces so the Auto lane feeds straight on. Multi-cam -> switches.json (via the
// groupId from multicam.json); single-source -> cut.json (via the sources.json meta, VS-104).
// Returns { landedCut, outPath? }; a missing/invalid plan is a graceful no-op so the frontend
// falls back to the deterministic design-cut baseline. The parse/validate/translate pieces are
// pure + unit-tested; only the fs read/write is here.
function tryLandCutPlan(folder, text) {
  if (!folder) return { landedCut: false };
  const raw = extractCutPlan(text);
  if (!raw) return { landedCut: false };
  const mcPath = path.join(folder, "multicam.json");
  if (fs.existsSync(mcPath)) return landMulticamPlan(folder, raw, mcPath);
  const srcPath = path.join(folder, "sources.json");
  if (fs.existsSync(srcPath)) return landSingleSourcePlan(folder, raw, srcPath);
  return { landedCut: false };
}

// Multi-cam: the plan is switches; reject a hallucinated/placeholder angle before landing.
function landMulticamPlan(folder, raw, mcPath) {
  const v = validateCutPlan(raw);
  if (!v.ok) return { landedCut: false };
  let group;
  try {
    group = JSON.parse(fs.readFileSync(mcPath, "utf8"))?.groups?.[0];
  } catch {
    return { landedCut: false };
  }
  const groupId = group?.id;
  if (typeof groupId !== "string" || groupId === "") return { landedCut: false };
  const validIds = Array.isArray(group.members) ? group.members.map((m) => m && m.id) : [];
  if (unknownPlanMembers(v.plan, validIds).length > 0) return { landedCut: false };
  const doc = cutPlanToSwitches(v.plan, groupId, {
    rationale: typeof raw.rationale === "string" ? raw.rationale : undefined,
  });
  const outPath = path.join(folder, "switches.json");
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return { landedCut: true, outPath };
}

// Single-source (VS-104): the plan is clip ranges; land a cut.json over the project's video.
function landSingleSourcePlan(folder, raw, srcPath) {
  const v = validateSingleSourceCutPlan(raw);
  if (!v.ok) return { landedCut: false };
  let sources;
  try {
    sources = JSON.parse(fs.readFileSync(srcPath, "utf8"));
  } catch {
    return { landedCut: false };
  }
  let doc;
  try {
    doc = cutPlanToCutSpec(v.plan, sources);
  } catch {
    return { landedCut: false };
  }
  const outPath = path.join(folder, "cut.json");
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return { landedCut: true, outPath };
}

// ---- Ollama (local model) backend (R-CB5) --------------------------------------------------
// Local chat models have no agentic tool SDK, so we run an app-driven constrained tool loop:
// the pure ollama-backend.mjs decides the protocol (prompt/parse/step); this is the I/O edge —
// the HTTP call to Ollama + the tool execution, each tool gated through OUR decide() choke
// point (R-CB9), identical to the Claude backend's canUseTool.
const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://localhost:11434";

// One chat completion from Ollama (non-streaming). Returns the assistant message content.
async function ollamaChat(model, messages) {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json();
  return data && data.message && typeof data.message.content === "string" ? data.message.content : "";
}

// Pick the model: an explicit param/config wins, else the first model Ollama has installed.
async function pickOllamaModel(preferred) {
  if (typeof preferred === "string" && preferred !== "") return preferred;
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await res.json();
    return data && Array.isArray(data.models) && data.models[0] ? data.models[0].name : null;
  } catch {
    return null;
  }
}

// Map an Ollama tool request onto our permission choke point so decide() gates it exactly like
// a Claude tool call: read_file -> a Read; propose_baseline -> our pipeline (Bash/media).
function ollamaToolDecision(tool, input, projectRoot, rules) {
  if (tool === "read_file") {
    const abs = path.resolve(projectRoot, String(input.path || ""));
    return decide("Read", { file_path: abs }, projectRoot, rules);
  }
  if (tool === "propose_baseline") {
    return decide("Bash", { command: `node ${path.join(REPO_ROOT, "tools/propose-switches.mjs")}` }, projectRoot, rules);
  }
  return "ask";
}

// Spawn one of our pipeline tools and capture its combined output (for feeding back to the
// model). Distinct from runToolCommand, which streams a step result to the shell.
function execToolCapture(command) {
  return new Promise((resolve) => {
    let argv;
    try {
      argv = toolArgv(command.tool, REPO_ROOT);
    } catch (err) {
      resolve({ ok: false, output: err.message });
      return;
    }
    const child = spawn(argv[0], [...argv.slice(1), ...command.args], { cwd: REPO_ROOT });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: out }));
  });
}

// Execute an (already permission-approved) Ollama tool and return a string result for the model.
async function execOllamaTool(tool, input, projectRoot) {
  if (tool === "read_file") {
    const abs = path.resolve(projectRoot, String(input.path || ""));
    if (!isInProject(abs, projectRoot)) return "Error: path is outside the project folder.";
    if (!fs.existsSync(abs)) return `Error: file not found: ${input.path}`;
    try {
      return fs.readFileSync(abs, "utf8").slice(0, 4000);
    } catch (err) {
      return `Error reading file: ${err.message}`;
    }
  }
  if (tool === "propose_baseline") {
    if (!fs.existsSync(path.join(projectRoot, "multicam.json"))) return "Error: no multicam.json in the project.";
    const command = proposeCommand(projectRoot, {
      hasAudioEvents: fs.existsSync(path.join(projectRoot, "audio-events.json")),
      hasSaliency: fs.existsSync(path.join(projectRoot, "saliency.json")),
    });
    const res = await execToolCapture(command);
    const sw = path.join(projectRoot, "switches.json");
    if (fs.existsSync(sw)) return fs.readFileSync(sw, "utf8").slice(0, 4000);
    return res.ok ? "Baseline ran but wrote no switches.json." : `Error running baseline: ${res.output.slice(0, 400)}`;
  }
  return `Error: unknown tool ${tool}`;
}

// Drive a local model through the constrained tool loop until it produces a cut plan (R-CB5).
// Reuses tryLandCutPlan so a valid plan lands exactly like the Claude backend's.
async function runOllamaAgent(id, { prompt, folder, model }) {
  const projectRoot = folder || REPO_ROOT;
  const rules = loadConfig().rules;
  const chosen = await pickOllamaModel(model);
  if (!chosen) {
    send(errorMessage(id, "not_connected", "No Ollama model available — install one with `ollama pull <model>`."));
    return;
  }
  send(progressMessage(id, { label: "Local model", detail: chosen }));
  const messages = buildOllamaMessages(prompt, projectRoot);
  try {
    let step = 0;
    for (;;) {
      const content = await ollamaChat(chosen, messages);
      const reply = parseModelReply(content);
      const action = nextLoopAction(reply, { step });
      if (action.action === "final") {
        const landed = tryLandCutPlan(projectRoot, action.text);
        send(resultMessage(id, { ok: true, text: action.text, ...landed }));
        return;
      }
      if (action.action === "stop") {
        send(resultMessage(id, { ok: true, text: reply.text || "", landedCut: false }));
        return;
      }
      send(progressMessage(id, { label: `Tool: ${action.tool}`, detail: JSON.stringify(action.input).slice(0, 80) }));
      const decision = ollamaToolDecision(action.tool, action.input, projectRoot, rules);
      const result =
        decision === "allow"
          ? await execOllamaTool(action.tool, action.input, projectRoot)
          : `Denied by video-studio's safety policy (${action.tool}).`;
      messages.push({ role: "assistant", content });
      messages.push(toolResultMessage(action.tool, result));
      step += 1;
    }
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `Ollama run failed: ${err.message}`));
  }
}

// ---- Codex backend (R-CB4) -----------------------------------------------------------------
// Codex is agentic (native tool-use/sessions/structured output), so we drive `codex exec
// --json` and normalize its JSONL stream (codex-backend.mjs) to the shared event shape. Its
// permission boundary is the SANDBOX MODE, not a per-call callback: we run `-s read-only`
// (R-CB9) so Codex may read the project to design the cut but never writes/executes — OUR host
// lands the plan from Codex's --output-last-message file.

// A Codex-labelled activity-feed line from a normalized event (the feed is backend-agnostic,
// but we name the assistant "Codex" rather than the shared "Claude" label).
function codexFeedEntry(n) {
  if (n.kind === AGENT_EVENT_KINDS.SESSION) return { label: "Session started", detail: n.sessionId || "" };
  if (n.kind === AGENT_EVENT_KINDS.ASSISTANT) {
    if (n.tools && n.tools.length > 0) return { label: "Running a command", detail: "" };
    if (n.text) return { label: "Codex", detail: n.text };
  }
  return null;
}

function runCodexAgent(id, { prompt, folder, model }) {
  const projectRoot = folder || REPO_ROOT;
  let workDir;
  let schemaPath;
  let lastPath;
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-codex-"));
    schemaPath = path.join(workDir, "cutplan.schema.json");
    lastPath = path.join(workDir, "last.txt");
    fs.writeFileSync(schemaPath, JSON.stringify(CODEX_CUTPLAN_SCHEMA));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `codex setup failed: ${err.message}`));
    return;
  }
  const args = codexExecArgv(prompt, projectRoot, { model, schemaPath, lastMessagePath: lastPath });
  // stdin: "ignore" gives codex an immediate-EOF stdin (like `< /dev/null`) so it takes the
  // prompt from argv and doesn't block/err waiting for piped input.
  const child = spawn("codex", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  inflight.set(id, child);
  let buf = "";
  let stderr = "";
  let sessionId = null;
  let failText = null; // a turn.failed / error event's message (the real cause on non-zero exit)
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const n = normalizeCodexEvent(ev);
      if (n.kind === AGENT_EVENT_KINDS.SESSION && n.sessionId) sessionId = n.sessionId;
      if (n.kind === AGENT_EVENT_KINDS.RESULT && n.ok === false && n.text) failText = n.text;
      const feed = codexFeedEntry(n);
      if (feed) send(progressMessage(id, feed));
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (err) => {
    inflight.delete(id);
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `codex not available: ${err.message}`));
  });
  child.on("close", (code) => {
    inflight.delete(id);
    if (code !== 0) {
      const msg = failText || stderr.trim() || `codex exited with code ${code}`;
      const authish = /auth|login|credential|not logged in|sign ?in/i.test(msg);
      send(errorMessage(id, authish ? "not_connected" : ERROR_CODES.STEP_FAILED, msg.slice(0, 300)));
      return;
    }
    let text = "";
    try {
      text = fs.readFileSync(lastPath, "utf8");
    } catch {
      /* no final message file */
    }
    const landed = tryLandCutPlan(projectRoot, text);
    send(resultMessage(id, { sessionId, ok: true, text, ...landed }));
  });
}

// The Auto lane's live engine (R-CB3): drive Claude headless via @anthropic-ai/claude-agent-sdk.
// The pure normalize/feed/auth logic (agent.mjs) + the permission decision (permissions.mjs)
// are unit-tested; this is the I/O edge that runs the SDK and streams its events. The SDK is
// lazy-imported so the host doesn't pay its (heavy) load unless the Auto lane is used.
async function runAgentRun(id, { prompt, folder, resume }) {
  let query;
  try {
    ({ query } = await import("@anthropic-ai/claude-agent-sdk"));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `agent SDK not available: ${err.message}`));
    return;
  }
  const projectRoot = folder || REPO_ROOT;
  const rules = loadConfig().rules;

  // The reason string for a decision our policy won't allow.
  const denyReason = (d) =>
    d === "deny"
      ? "Blocked by video-studio's safety policy."
      : "Needs your approval — interactive permission prompts are coming soon.";

  // Every non-pre-approved tool the agent wants flows through OUR safety layer (R-CB9): allow
  // silently, deny, or — since the interactive native prompt isn't wired through the sidecar
  // yet — deny an "ask" with an explanation (the run continues; that one action is blocked).
  const canUseTool = async (toolName, input) => {
    const d = decide(toolName, input, projectRoot, rules);
    if (d === "allow") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: denyReason(d) };
  };

  // Defense-in-depth (VS-97): a PreToolUse hook fires for EVERY tool call — including the ones
  // the SDK auto-approves in its own bash sandbox, which never reach canUseTool. Running our
  // policy here makes video-studio the authoritative gate: our layer can block any tool
  // (prompt-injection or model mistake) even when the SDK would have sandboxed-and-allowed it.
  const preToolUse = async (input) => {
    const d = decide(input.tool_name, input.tool_input, projectRoot, rules);
    if (d === "allow") return {}; // no objection — let the normal flow proceed
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: denyReason(d),
      },
    };
  };

  // NOTE (VS-96): we deliberately do NOT set options.allowedTools here. The safe categories
  // (media/read/write) are already "allow" in canUseTool, so an allow-list adds no friction
  // benefit — but a bare allowedTools entry AUTO-APPROVES the tool *before* canUseTool is
  // consulted (SDK CLAUDE_SDK_CAN_USE_TOOL_SHADOWED), collapsing our two-point gate
  // (canUseTool + PreToolUse hook, VS-97) to one. Keeping both layers is worth more than the
  // (nonexistent) friction saving. deriveAllowedTools stays available for when native prompts
  // change this calculus.
  const options = {
    cwd: projectRoot,
    permissionMode: "default",
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
  };
  if (resume) options.resume = resume;

  let sessionId = null;
  try {
    for await (const msg of query({ prompt: String(prompt ?? ""), options })) {
      const n = normalizeClaudeEvent(msg);
      if (n.kind === AGENT_EVENT_KINDS.SESSION && n.sessionId) sessionId = n.sessionId;
      if (n.kind === AGENT_EVENT_KINDS.RESULT && isAuthFailure(n)) {
        send(errorMessage(id, "not_connected", n.text || "Claude is not connected."));
        return;
      }
      const feed = eventToFeedEntry(n);
      if (feed) send(progressMessage(id, feed));
      if (n.kind === AGENT_EVENT_KINDS.RESULT) {
        const landed = n.ok ? tryLandCutPlan(folder, n.text) : { landedCut: false };
        send(resultMessage(id, { sessionId, ok: n.ok, text: n.text, ...landed }));
        return;
      }
    }
    send(resultMessage(id, { sessionId, ok: true, text: "" }));
  } catch (err) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, `agent run failed: ${err.message}`));
  }
}

function handle(decoded) {
  // The doctor + project + config + export steps are handled here (not via the registry):
  // doctor is a fan-out of probes; the others are filesystem/tool orchestration around the
  // pure cores, not a plain registry spawn.
  if (decoded && typeof decoded === "object" && decoded.type === MESSAGE_TYPES.REQUEST) {
    const id = typeof decoded.id === "string" || Number.isFinite(decoded.id) ? decoded.id : null;
    const params = decoded.params && typeof decoded.params === "object" ? decoded.params : {};
    if (decoded.step === "doctor") {
      if (id !== null) runDoctor(id);
      return;
    }
    if (decoded.step === "project-open") {
      if (id !== null) {
        if (params.folder) runProjectOpen(id, params.folder);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "project-open requires param: folder"));
      }
      return;
    }
    if (decoded.step === "project-create") {
      if (id !== null) {
        if (params.folder) runProjectCreate(id, params.folder, params.name);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "project-create requires param: folder"));
      }
      return;
    }
    if (typeof decoded.step === "string" && decoded.step.startsWith("config-")) {
      if (id !== null && !handleConfigStep(id, decoded.step, params)) {
        send(errorMessage(id, ERROR_CODES.UNKNOWN_STEP, `unknown step: ${decoded.step}`));
      }
      return;
    }
    if (typeof decoded.step === "string" && decoded.step in EXPORT_STEPS) {
      if (id !== null) {
        if (params.folder) runExport(id, EXPORT_STEPS[decoded.step], params.folder);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, `${decoded.step} requires param: folder`));
      }
      return;
    }
    if (decoded.step === "import-footage") {
      if (id !== null) {
        if (params.folder) runImportFootage(id, params.folder);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "import-footage requires param: folder"));
      }
      return;
    }
    if (decoded.step === "analyze-project") {
      if (id !== null) {
        if (params.folder) runAnalyzeProject(id, params.folder);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "analyze-project requires param: folder"));
      }
      return;
    }
    if (decoded.step === "design-cut") {
      if (id !== null) {
        if (params.folder) runDesignCut(id, params.folder, params.kind);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "design-cut requires param: folder"));
      }
      return;
    }
    if (decoded.step === "review-start") {
      if (id !== null) {
        if (params.folder) runReviewStart(id, params.folder);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "review-start requires param: folder"));
      }
      return;
    }
    if (decoded.step === "review-stop") {
      if (id !== null) runReviewStop(id);
      return;
    }
    if (decoded.step === "agent-run") {
      if (id !== null) {
        if (!params.prompt) {
          send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "agent-run requires param: prompt"));
        } else {
          // Select the backend (R-CB1): explicit param wins, else the app-global config, else
          // Claude. The permission choke point (decide) + tryLandCutPlan are shared.
          const backend = params.backend || loadConfig().agentBackend || "claude";
          if (backend === "ollama") runOllamaAgent(id, params);
          else if (backend === "codex") runCodexAgent(id, params);
          else runAgentRun(id, params);
        }
      }
      return;
    }
  }
  const v = validateRequest(decoded, STEP_REGISTRY);
  if (!v.ok) {
    if (v.id !== null) send(errorMessage(v.id, v.code, v.message));
    return;
  }
  if (v.kind === MESSAGE_TYPES.CANCEL) {
    const child = inflight.get(v.id);
    if (child) killTree(child);
    return;
  }
  runStep(v);
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  const { messages, rest } = parseFrames(stdinBuffer);
  stdinBuffer = rest;
  for (const m of messages) {
    if (m.ok) handle(m.value);
    else send(errorMessage(null, ERROR_CODES.MALFORMED, m.error));
  }
});
process.stdin.on("end", () => {
  for (const child of inflight.values()) killTree(child);
  if (reviewServer) killTree(reviewServer.child);
});

send(readyMessage());

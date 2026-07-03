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
import { normalizeClaudeEvent, eventToFeedEntry, isAuthFailure, AGENT_EVENT_KINDS } from "./agent.mjs";
import { decide } from "./permissions.mjs";

// The repo root is two levels up from desktop/sidecar/. The app lives in a subdir
// of this repo (settled), so the pipeline tools sit alongside at ../../.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const inflight = new Map(); // id -> ChildProcess

function send(obj) {
  process.stdout.write(frameMessage(obj));
}

function runStep({ id, step, params }) {
  const descriptor = STEP_REGISTRY[step];
  const { tool, args } = descriptor.buildCommand(params);
  const [cmd, entry] = toolArgv(tool, REPO_ROOT);
  const child = spawn(cmd, [entry, ...args], { cwd: REPO_ROOT });
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

const EXPORT_STEPS = { "export-mp4": "mp4", "export-social": "social", "export-fcpxml": "fcpxml" };

// Stream a one-shot tool command (like export/propose): spawn, forward output as progress,
// return { ...extra, ok } on success. Shared by the export + design-cut steps.
function runToolCommand(id, command, extra) {
  const [cmd, entry] = toolArgv(command.tool, REPO_ROOT);
  const child = spawn(cmd, [entry, ...command.args], { cwd: REPO_ROOT });
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
    else send(errorMessage(id, ERROR_CODES.STEP_FAILED, `${command.tool} exited with code ${code}`));
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

// The Manual lane's auto starting point (R-DS2): propose an initial cut into switches.json.
function runDesignCut(id, folder) {
  if (!fs.existsSync(path.join(folder, "multicam.json"))) {
    send(errorMessage(id, ERROR_CODES.STEP_FAILED, "design needs multicam.json (import a multi-cam project first)"));
    return;
  }
  const command = proposeCommand(folder, {
    hasAudioEvents: fs.existsSync(path.join(folder, "audio-events.json")),
    hasSaliency: fs.existsSync(path.join(folder, "saliency.json")),
  });
  runToolCommand(id, command, { outPath: command.outPath });
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
  const child = spawn(cmd, [entry, ...args], { cwd: REPO_ROOT });
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
    reviewServer.child.kill("SIGTERM");
    reviewServer = null;
  }
  send(resultMessage(id, { stopped: true }));
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

  // Every non-pre-approved tool the agent wants flows through OUR safety layer (R-CB9): allow
  // silently, deny, or — since the interactive native prompt isn't wired through the sidecar
  // yet — deny an "ask" with an explanation (the run continues; that one action is blocked).
  const canUseTool = async (toolName, input) => {
    const d = decide(toolName, input, projectRoot, rules);
    if (d === "allow") return { behavior: "allow", updatedInput: input };
    if (d === "deny") return { behavior: "deny", message: "Blocked by video-studio's safety policy." };
    return { behavior: "deny", message: "Needs your approval — interactive permission prompts are coming soon." };
  };

  const options = { cwd: projectRoot, permissionMode: "default", canUseTool };
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
        send(resultMessage(id, { sessionId, ok: n.ok, text: n.text }));
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
        if (params.folder) runDesignCut(id, params.folder);
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
        if (params.prompt) runAgentRun(id, params);
        else send(errorMessage(id, ERROR_CODES.MISSING_PARAM, "agent-run requires param: prompt"));
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
    if (child) child.kill("SIGTERM");
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
  for (const child of inflight.values()) child.kill("SIGTERM");
  if (reviewServer) reviewServer.child.kill("SIGTERM");
});

send(readyMessage());

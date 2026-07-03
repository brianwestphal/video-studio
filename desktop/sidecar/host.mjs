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
import { STEP_REGISTRY, toolArgv } from "./steps.mjs";
import { DOCTOR_TOOLS, doctorResultFromChecks } from "./doctor.mjs";
import {
  PROJECT_STATE_DIR,
  PROJECT_STATE_FILE,
  deriveStages,
  newProjectState,
  reconcileProject,
} from "./project.mjs";

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

function handle(decoded) {
  // The doctor + project steps are handled here (not via the registry): doctor is a
  // fan-out of probes; the project steps are filesystem reads/writes, not a tool spawn.
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
});

send(readyMessage());

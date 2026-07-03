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

function handle(decoded) {
  // The doctor step is handled here (not via the registry) — it's a fan-out of
  // probes, not one child process.
  if (decoded && typeof decoded === "object" && decoded.type === MESSAGE_TYPES.REQUEST && decoded.step === "doctor") {
    const id = typeof decoded.id === "string" || Number.isFinite(decoded.id) ? decoded.id : null;
    if (id === null) return;
    runDoctor(id);
    return;
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

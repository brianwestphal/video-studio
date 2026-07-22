// Sidecar protocol — the typed request/stream contract between the Tauri (Rust)
// shell and the long-lived Node sidecar host (R-APP12, docs/desktop-app.md §5).
//
// Wire format is newline-delimited JSON (NDJSON) over stdio, matching the glassbox
// pattern (the Rust side reads stdout line-by-line and emits Tauri events). Every
// function here is PURE + side-effect-free so it is unit-tested to 100%; the actual
// stdin/stdout plumbing + child-process spawning lives in host.mjs (I/O edge).
//
// Message shapes:
//   shell → host:  { type: "request", id, step, params }   run a pipeline step
//                  { type: "cancel",  id }                  cancel an in-flight request
//                  { type: "interaction-response", interactionId, decision, value? }
//   host → shell:  { type: "ready" }                        startup handshake
//                  { type: "progress", id, progress }       incremental progress
//                  { type: "result",   id, data }           terminal success
//                  { type: "error",    id, error:{code,message} }  terminal failure
//                  { type: "interaction-request", interactionId, interaction }

export const MESSAGE_TYPES = Object.freeze({
  REQUEST: "request",
  CANCEL: "cancel",
  READY: "ready",
  PROGRESS: "progress",
  RESULT: "result",
  ERROR: "error",
  INTERACTION_REQUEST: "interaction-request",
  INTERACTION_RESPONSE: "interaction-response",
});

// Error codes the host can report on a request that never runs / fails.
export const ERROR_CODES = Object.freeze({
  MALFORMED: "malformed",       // could not JSON-parse a line
  BAD_REQUEST: "bad_request",   // parsed, but not a valid request envelope
  UNKNOWN_STEP: "unknown_step", // step name not in the registry
  MISSING_PARAM: "missing_param", // a required param was absent
  STEP_FAILED: "step_failed",   // the child process exited non-zero
});

// Encode one message object as a single NDJSON line (JSON + trailing newline).
export function frameMessage(obj) {
  return JSON.stringify(obj) + "\n";
}

// Split an accumulated stdio buffer into complete messages + the trailing partial
// line. Pure: the caller owns the running buffer. Each element of `messages` is
// `{ ok: true, value }` for a parseable line or `{ ok: false, error, raw }` for a
// malformed one — so a single garbled line never poisons the whole stream.
export function parseFrames(buffer) {
  const parts = String(buffer ?? "").split("\n");
  // split() always yields ≥1 element, so pop() is always a string (the trailing
  // partial line, or "" when the buffer ended in a newline).
  const rest = parts.pop();
  const messages = [];
  for (const line of parts) {
    if (line.trim() === "") continue; // tolerate blank lines / keepalives
    try {
      messages.push({ ok: true, value: JSON.parse(line) });
    } catch (err) {
      messages.push({ ok: false, error: err.message, raw: line });
    }
  }
  return { messages, rest };
}

// --- host → shell message constructors ------------------------------------

export function readyMessage() {
  return { type: MESSAGE_TYPES.READY };
}

export function progressMessage(id, progress) {
  return { type: MESSAGE_TYPES.PROGRESS, id, progress };
}

export function resultMessage(id, data) {
  return { type: MESSAGE_TYPES.RESULT, id, data };
}

export function errorMessage(id, code, message) {
  return { type: MESSAGE_TYPES.ERROR, id, error: { code, message } };
}

export function interactionRequestMessage(interactionId, interaction) {
  return { type: MESSAGE_TYPES.INTERACTION_REQUEST, interactionId, interaction };
}

export function interactionResponseMessage(interactionId, decision, value) {
  const message = { type: MESSAGE_TYPES.INTERACTION_RESPONSE, interactionId, decision };
  if (value !== undefined) message.value = value;
  return message;
}

export function validateInteractionResponse(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.type !== MESSAGE_TYPES.INTERACTION_RESPONSE || !hasValidId(obj.interactionId)) return null;
  if (!["allow-once", "always-allow", "deny", "completed", "cancelled"].includes(obj.decision)) return null;
  return { interactionId: obj.interactionId, decision: obj.decision, value: obj.value };
}

// --- request validation ----------------------------------------------------

// Validate a decoded shell→host message against the step registry. Returns a
// discriminated result: a `request`/`cancel` is normalized; anything else yields
// `{ ok: false, id, code, message }` the host can turn into an error frame. `id`
// is echoed back when present so the shell can correlate the failure.
export function validateRequest(obj, registry) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, id: null, code: ERROR_CODES.BAD_REQUEST, message: "message is not an object" };
  }
  const id = hasValidId(obj.id) ? obj.id : null;

  if (obj.type === MESSAGE_TYPES.CANCEL) {
    if (id === null) {
      return { ok: false, id: null, code: ERROR_CODES.BAD_REQUEST, message: "cancel is missing a valid id" };
    }
    return { ok: true, kind: MESSAGE_TYPES.CANCEL, id };
  }

  if (obj.type !== MESSAGE_TYPES.REQUEST) {
    return { ok: false, id, code: ERROR_CODES.BAD_REQUEST, message: `unsupported message type: ${String(obj.type)}` };
  }
  if (id === null) {
    return { ok: false, id: null, code: ERROR_CODES.BAD_REQUEST, message: "request is missing a valid id" };
  }
  if (typeof obj.step !== "string" || obj.step === "") {
    return { ok: false, id, code: ERROR_CODES.BAD_REQUEST, message: "request is missing a step name" };
  }
  const step = registry && registry[obj.step];
  if (!step) {
    return { ok: false, id, code: ERROR_CODES.UNKNOWN_STEP, message: `unknown step: ${obj.step}` };
  }
  const params = obj.params && typeof obj.params === "object" && !Array.isArray(obj.params) ? obj.params : {};
  for (const name of step.requiredParams ?? []) {
    if (params[name] === undefined || params[name] === null || params[name] === "") {
      return { ok: false, id, code: ERROR_CODES.MISSING_PARAM, message: `step ${obj.step} requires param: ${name}` };
    }
  }
  return { ok: true, kind: MESSAGE_TYPES.REQUEST, id, step: obj.step, params };
}

// A valid correlation id is a non-empty string or a finite number.
function hasValidId(id) {
  if (typeof id === "string") return id !== "";
  if (typeof id === "number") return Number.isFinite(id);
  return false;
}

// AI agent bridge — pure core (docs/desktop-app-agent-bridge.md, VS-91). The Auto
// lane runs an agent backend (Claude first) headlessly and consumes its structured
// event stream. This module is the PURE, backend-agnostic heart:
//   - normalizeClaudeEvent  — Claude Agent SDK message -> a normalized event shape
//     (R-CB2: unknown types are tolerated, never fatal),
//   - eventToFeedEntry      — normalized event -> a friendly activity-feed line (R-CB6),
//   - validateCutPlan       — validate the structured "cut plan" result (R-CB7),
//   - isAuthFailure         — detect a credential failure from a result event (R-CB11).
// The live SDK run + session resume + the canUseTool choke point are the I/O edge
// (host.mjs + the permission layer VS-92), unit-tested via the pure pieces here.

export const AGENT_EVENT_KINDS = Object.freeze({
  SESSION: "session",
  SYSTEM: "system",
  ASSISTANT: "assistant",
  TOOL_RESULT: "tool-result",
  RESULT: "result",
  UNKNOWN: "unknown",
});

// Pull the concatenated text + any tool_use parts out of an assistant message's
// `content` array (the Claude Agent SDK shape). Pure.
function readAssistantContent(message) {
  const content = message && Array.isArray(message.content) ? message.content : [];
  let text = "";
  const tools = [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") text += part.text;
    else if (part && part.type === "tool_use") tools.push({ name: String(part.name ?? ""), input: part.input ?? {} });
  }
  return { text: text.trim(), tools };
}

// Normalize one Claude Agent SDK stream message to a backend-agnostic event. Unknown
// message types map to `{ kind: "unknown" }` so a schema change never breaks the feed.
export function normalizeClaudeEvent(ev) {
  if (ev === null || typeof ev !== "object") {
    return { kind: AGENT_EVENT_KINDS.UNKNOWN, type: String(ev) };
  }
  switch (ev.type) {
    case "system":
      if (ev.subtype === "init") return { kind: AGENT_EVENT_KINDS.SESSION, sessionId: ev.session_id ?? null };
      return { kind: AGENT_EVENT_KINDS.SYSTEM, subtype: ev.subtype ?? null };
    case "assistant": {
      const { text, tools } = readAssistantContent(ev.message);
      return { kind: AGENT_EVENT_KINDS.ASSISTANT, text, tools };
    }
    case "user":
      return { kind: AGENT_EVENT_KINDS.TOOL_RESULT };
    case "result":
      return {
        kind: AGENT_EVENT_KINDS.RESULT,
        ok: ev.is_error !== true,
        text: typeof ev.result === "string" ? ev.result : "",
        subtype: ev.subtype ?? null,
      };
    default:
      return { kind: AGENT_EVENT_KINDS.UNKNOWN, type: typeof ev.type === "string" ? ev.type : null };
  }
}

// Friendly labels for our own pipeline tools, so the feed reads "Analyzing scenes"
// rather than a raw tool name. Unknown tools fall back to the raw name.
const TOOL_LABELS = Object.freeze({
  "analyze-scenes": "Analyzing scenes",
  "analyze-audio-events": "Analyzing audio",
  "analyze-sources": "Analyzing sources",
  "propose-switches": "Designing the cut",
});

// Map a normalized event to a single activity-feed entry `{ label, detail }`, or null
// to skip it (R-CB6). Pure + total.
export function eventToFeedEntry(n) {
  switch (n && n.kind) {
    case AGENT_EVENT_KINDS.SESSION:
      return { label: "Session started", detail: n.sessionId ?? "" };
    case AGENT_EVENT_KINDS.SYSTEM:
      return { label: "System", detail: n.subtype ?? "" };
    case AGENT_EVENT_KINDS.ASSISTANT:
      if (n.tools.length > 0) {
        const t = n.tools[0];
        return { label: TOOL_LABELS[t.name] ?? `Using ${t.name}`, detail: "" };
      }
      if (n.text !== "") return { label: "Claude", detail: n.text };
      return null;
    case AGENT_EVENT_KINDS.TOOL_RESULT:
      return null; // tool results are internal; the next assistant turn narrates them
    case AGENT_EVENT_KINDS.RESULT:
      return { label: n.ok ? "Done" : "Failed", detail: n.text ?? "" };
    default:
      return null;
  }
}

// Validate the structured "cut plan" an agent returns (R-CB7) — the app renders it
// into Review instead of parsing prose. Shape: `{ switches: [{ atSeconds, memberId }] }`,
// mirroring switches.json. Returns `{ ok: true, plan }` (normalized, sorted) or
// `{ ok: false, error }`. Pure.
export function validateCutPlan(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "cut plan is not an object" };
  }
  if (!Array.isArray(obj.switches)) {
    return { ok: false, error: "cut plan is missing a switches array" };
  }
  const switches = [];
  for (const [i, sw] of obj.switches.entries()) {
    if (sw === null || typeof sw !== "object") {
      return { ok: false, error: `switch ${i} is not an object` };
    }
    if (typeof sw.atSeconds !== "number" || !Number.isFinite(sw.atSeconds) || sw.atSeconds < 0) {
      return { ok: false, error: `switch ${i} has an invalid atSeconds` };
    }
    if (typeof sw.memberId !== "string" || sw.memberId === "") {
      return { ok: false, error: `switch ${i} is missing a memberId` };
    }
    switches.push({ atSeconds: sw.atSeconds, memberId: sw.memberId });
  }
  switches.sort((a, b) => a.atSeconds - b.atSeconds);
  return { ok: true, plan: { switches } };
}

// The switches.json schema version the pipeline writes/reads.
export const SWITCHES_VERSION = 1;

// Turn a validated cut plan (from validateCutPlan) into a switches.json **document** the
// project can write — the review UI + exporters read `{ version, groupId, switches }`
// (rationale optional). The plan carries only the switches; the groupId comes from the
// project's multicam.json. Pure. Throws on a missing/empty groupId so a bad handoff fails
// loudly rather than writing an unusable cut. This is the R-CB7 Auto-lane -> Review bridge:
// the agent returns a plan; this makes it the same artifact the Manual lane produces.
export function cutPlanToSwitches(plan, groupId, { rationale } = {}) {
  if (typeof groupId !== "string" || groupId === "") {
    throw new Error("cutPlanToSwitches requires a non-empty groupId");
  }
  const switches = plan && Array.isArray(plan.switches) ? plan.switches : [];
  const doc = {
    version: SWITCHES_VERSION,
    groupId,
    switches: switches.map((s) => ({ atSeconds: s.atSeconds, memberId: s.memberId })),
  };
  if (typeof rationale === "string" && rationale !== "") doc.rationale = rationale;
  return doc;
}

// Detect a credential/auth failure from a normalized result event (R-CB11) so the app
// can trigger the Connect flow rather than showing a generic error. Pure.
const AUTH_RE = /\b(auth|authenticat|credential|unauthor|not logged in|log ?in|setup-token|api[- ]?key|401)\b/i;
export function isAuthFailure(n) {
  return !!(n && n.kind === AGENT_EVENT_KINDS.RESULT && n.ok === false && AUTH_RE.test(n.text ?? ""));
}

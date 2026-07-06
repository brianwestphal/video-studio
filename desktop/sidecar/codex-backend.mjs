// Codex Auto-lane backend — the PURE core (R-CB4, docs/desktop-app-agent-bridge.md).
//
// Unlike Ollama (a constrained loop over a bare chat model), Codex is itself an agentic tool
// with native tool-use, sessions, and structured output. We drive it headless via
// `codex exec --json` and NORMALIZE its JSONL event stream to the SAME backend-agnostic event
// shape the Claude backend produces (R-CB6), so eventToFeedEntry + the cut-plan landing are
// reused unchanged. Codex's permission granularity is its SANDBOX MODE (not a per-call
// callback), so R-CB9 maps our policy to a conservative `-s read-only` sandbox: Codex may read
// the project to design the cut, but never writes/executes — OUR host lands the plan. This
// module holds the pure pieces (event normalizer, exec argv, capabilities, output schema);
// host.mjs spawns codex + reads its final message (the I/O edge).

import { AGENT_EVENT_KINDS } from "./agent.mjs";

// Capability flags (R-CB1). Codex supports native sessions/resume + tool-use + structured
// output; its permission model is sandbox-based (no per-call callback). Auth is ChatGPT/Codex.
export const CODEX_CAPABILITIES = Object.freeze({
  backend: "codex",
  nativeSession: true, // codex exec resume <thread_id>
  nativeToolUse: true, // native agentic tools
  permissionCallback: false, // gated by sandbox mode, not a per-call callback
  structuredOutput: true, // --output-schema constrains the final message
  auth: "chatgpt", // its own credential path (R-CB11)
});

// The JSON Schema handed to `codex exec --output-schema` so the FINAL message is the cut plan
// (mirrors validateCutPlan's shape). Pure data.
export const CODEX_CUTPLAN_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    switches: {
      type: "array",
      items: {
        type: "object",
        properties: { atSeconds: { type: "number" }, memberId: { type: "string" } },
        required: ["atSeconds", "memberId"],
        additionalProperties: false,
      },
    },
    rationale: { type: "string" },
  },
  // OpenAI strict structured-output requires EVERY property to be listed in `required`.
  required: ["switches", "rationale"],
  additionalProperties: false,
});

// Build the `codex exec` argv for a fresh run (R-CB4). Read-only sandbox is the permission
// boundary (R-CB9); --json streams events; -o writes the final message to a file we then land.
// Pure.
export function codexExecArgv(prompt, folder, { model, schemaPath, lastMessagePath } = {}) {
  const args = ["exec", "--json", "-s", "read-only", "--skip-git-repo-check", "-C", folder];
  if (model) args.push("-m", model);
  if (schemaPath) args.push("--output-schema", schemaPath);
  if (lastMessagePath) args.push("-o", lastMessagePath);
  args.push(String(prompt ?? ""));
  return args;
}

// Pull a human error string out of a codex failure event. Pure.
function codexErrorText(ev) {
  if (typeof ev.message === "string") return ev.message;
  if (ev.error && typeof ev.error.message === "string") return ev.error.message;
  return "Codex run failed.";
}

// Normalize one Codex JSONL event to the shared backend-agnostic shape (R-CB6) so the feed +
// landing code is provider-agnostic (R-CB2). Unknown types are tolerated -> UNKNOWN (never
// fatal, R-CB3). Pure + total. The final answer text is read from Codex's -o file, so the
// RESULT event here carries no text.
export function normalizeCodexEvent(ev) {
  if (ev === null || typeof ev !== "object") {
    return { kind: AGENT_EVENT_KINDS.UNKNOWN, type: String(ev) };
  }
  switch (ev.type) {
    case "thread.started":
      return { kind: AGENT_EVENT_KINDS.SESSION, sessionId: typeof ev.thread_id === "string" ? ev.thread_id : null };
    case "turn.completed":
      return { kind: AGENT_EVENT_KINDS.RESULT, ok: true, text: "" };
    case "turn.failed":
    case "error":
      return { kind: AGENT_EVENT_KINDS.RESULT, ok: false, text: codexErrorText(ev) };
    case "item.started":
    case "item.completed": {
      const item = ev.item && typeof ev.item === "object" ? ev.item : {};
      if (item.type === "agent_message") {
        // Only the completed message carries the final text; a started one is noise.
        return ev.type === "item.completed"
          ? { kind: AGENT_EVENT_KINDS.ASSISTANT, text: typeof item.text === "string" ? item.text : "", tools: [] }
          : { kind: AGENT_EVENT_KINDS.UNKNOWN, type: "item.started" };
      }
      if (item.type === "command_execution") {
        // A command call: surface the start as tool activity, the completion as an (ignored)
        // tool result — mirroring the Claude assistant-tool / tool-result pairing.
        return ev.type === "item.started"
          ? { kind: AGENT_EVENT_KINDS.ASSISTANT, text: "", tools: [{ name: "command" }] }
          : { kind: AGENT_EVENT_KINDS.TOOL_RESULT };
      }
      return { kind: AGENT_EVENT_KINDS.UNKNOWN, type: typeof item.type === "string" ? item.type : null };
    }
    default:
      return { kind: AGENT_EVENT_KINDS.UNKNOWN, type: typeof ev.type === "string" ? ev.type : null };
  }
}

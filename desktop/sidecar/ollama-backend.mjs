// Ollama (local model) Auto-lane backend — the PURE core (R-CB5, docs/desktop-app-agent-bridge.md).
//
// Local chat models lack an agentic tool-use SDK, so this backend runs an APP-DRIVEN
// constrained tool loop: the app offers a small tool catalog in the system prompt, the model
// replies with EITHER a tool request (a JSON object with a "tool" field) OR a final answer
// (ending in the cut-plan JSON). The app parses the reply, gates each tool through OUR
// permission choke point (R-CB9) before executing, feeds the result back, and repeats until a
// final answer or a step cap. This module holds the pure pieces — capabilities, the system
// prompt, the reply parser, and the loop-step reducer; host.mjs owns the HTTP call to Ollama
// and the tool execution (the I/O edge). No native session or native tool-use: both are
// emulated, never faked (R-CB2).

import { firstJsonObject } from "./agent.mjs";

// Capability flags (R-CB1) so the app degrades gracefully by capability. Pure data.
export const OLLAMA_CAPABILITIES = Object.freeze({
  backend: "ollama",
  nativeSession: false, // no server-side session/resume — the app replays context
  nativeToolUse: false, // no agentic tool SDK — app-driven constrained loop
  permissionCallback: true, // every tool routes through decide() before executing
  structuredOutput: false, // model-dependent; we parse a JSON block from the reply
  auth: "none", // local — no auth (R-CB11)
});

// The tools offered to the model. A curated, safe catalog: read a project file (so the model
// can learn the angle memberIds from multicam.json) and run the deterministic baseline cut.
// Each `name` maps to a host-side executor (the I/O edge). Pure data.
export const OLLAMA_TOOLS = Object.freeze([
  { name: "read_file", description: "Read a UTF-8 text file in the project folder. input: { \"path\": \"<relative path, e.g. multicam.json>\" }" },
  { name: "propose_baseline", description: "Run the deterministic auto-cut to get a starting switches.json you can refine. input: {}" },
]);

const TOOL_NAMES = new Set(OLLAMA_TOOLS.map((t) => t.name));

// The default step cap so a looping/confused model can't run forever. Pure constant.
export const OLLAMA_MAX_STEPS = 8;

// Build the chat messages that start a run: a system prompt that constrains the model to the
// tool protocol + the tool catalog, then the user's intent. Pure — returns [{role, content}].
export function buildOllamaMessages(prompt, folder, tools = OLLAMA_TOOLS) {
  const catalog = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
  const system =
    "You are video-studio's multi-cam cut designer. You work by REQUESTING TOOLS one at a time.\n" +
    `Project folder: ${folder}\n\n` +
    "Available tools:\n" +
    catalog +
    "\n\nTo use a tool, reply with ONLY a JSON object: " +
    '{ "tool": "<name>", "input": { ... } }\n' +
    "When you are done, reply with the final cut plan as a JSON object: " +
    '{ "switches": [ { "atSeconds": <number>, "memberId": "<angle id from multicam.json>" } ], "rationale": "<one line>" }\n' +
    "Only use memberIds that exist in multicam.json. Do not invent ids. Reply with JSON only, no prose.";
  return [
    { role: "system", content: system },
    { role: "user", content: String(prompt ?? "") },
  ];
}

// Parse a model reply into the next intent. A JSON object with a known "tool" string is a tool
// request; anything else is treated as the final answer (its text is handed to the cut-plan
// reader downstream). Pure. Returns { kind: "tool", tool, input } | { kind: "final", text }.
export function parseModelReply(text) {
  const obj = firstJsonObject(text);
  if (obj && typeof obj.tool === "string" && TOOL_NAMES.has(obj.tool)) {
    return { kind: "tool", tool: obj.tool, input: obj.input && typeof obj.input === "object" ? obj.input : {} };
  }
  return { kind: "final", text: typeof text === "string" ? text : "" };
}

// The loop-step reducer: given a parsed reply and the loop state, decide the next action. Pure.
//   { action: "execute", tool, input }  run a tool, then feed its result back
//   { action: "final", text }           stop — the model produced its answer
//   { action: "stop", reason }          give up (step cap) — the caller falls back to baseline
export function nextLoopAction(reply, { step, maxSteps = OLLAMA_MAX_STEPS } = {}) {
  if (reply && reply.kind === "tool") {
    if (step >= maxSteps) return { action: "stop", reason: `tool-step cap (${maxSteps}) reached` };
    return { action: "execute", tool: reply.tool, input: reply.input };
  }
  return { action: "final", text: reply ? reply.text : "" };
}

// Format a tool result to feed back to the model as the next user turn. Pure.
export function toolResultMessage(tool, result) {
  return { role: "user", content: `Result of ${tool}:\n${typeof result === "string" ? result : JSON.stringify(result)}` };
}

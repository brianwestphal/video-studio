import { describe, it, expect } from "vitest";
import {
  CODEX_CAPABILITIES,
  CODEX_CUTPLAN_SCHEMA,
  codexExecArgv,
  normalizeCodexEvent,
} from "../desktop/sidecar/codex-backend.mjs";
import { AGENT_EVENT_KINDS, eventToFeedEntry } from "../desktop/sidecar/agent.mjs";

describe("codex-backend — capabilities + schema", () => {
  it("advertises native sessions/tool-use/structured output, sandbox permission, chatgpt auth", () => {
    expect(CODEX_CAPABILITIES).toMatchObject({
      backend: "codex",
      nativeSession: true,
      nativeToolUse: true,
      permissionCallback: false,
      structuredOutput: true,
      auth: "chatgpt",
    });
    expect(Object.isFrozen(CODEX_CAPABILITIES)).toBe(true);
  });
  it("the cut-plan output schema matches the switches shape", () => {
    expect(CODEX_CUTPLAN_SCHEMA.required).toContain("switches");
    // OpenAI strict structured output: every property must be in `required`.
    expect(CODEX_CUTPLAN_SCHEMA.required).toEqual(Object.keys(CODEX_CUTPLAN_SCHEMA.properties));
    expect(CODEX_CUTPLAN_SCHEMA.properties.switches.items.required).toEqual(["atSeconds", "memberId"]);
  });
});

describe("codex-backend — codexExecArgv", () => {
  it("builds a read-only headless exec argv with the prompt last", () => {
    expect(codexExecArgv("make a cut", "/proj")).toEqual([
      "exec",
      "--json",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      "/proj",
      "make a cut",
    ]);
  });
  it("threads model / schema / last-message flags before the prompt", () => {
    const a = codexExecArgv("go", "/p", { model: "gpt-5", schemaPath: "/s.json", lastMessagePath: "/last.txt" });
    expect(a).toContain("-m");
    expect(a[a.indexOf("-m") + 1]).toBe("gpt-5");
    expect(a[a.indexOf("--output-schema") + 1]).toBe("/s.json");
    expect(a[a.indexOf("-o") + 1]).toBe("/last.txt");
    expect(a[a.length - 1]).toBe("go");
  });
  it("tolerates a nullish prompt", () => {
    expect(codexExecArgv(null, "/p").at(-1)).toBe("");
  });
});

describe("codex-backend — normalizeCodexEvent", () => {
  it("thread.started -> session with the thread id", () => {
    expect(normalizeCodexEvent({ type: "thread.started", thread_id: "t1" })).toEqual({
      kind: AGENT_EVENT_KINDS.SESSION,
      sessionId: "t1",
    });
    expect(normalizeCodexEvent({ type: "thread.started" }).sessionId).toBeNull();
  });
  it("turn.completed -> ok result; turn.failed/error -> failed result with a message", () => {
    expect(normalizeCodexEvent({ type: "turn.completed" })).toEqual({ kind: AGENT_EVENT_KINDS.RESULT, ok: true, text: "" });
    expect(normalizeCodexEvent({ type: "turn.failed", message: "boom" })).toEqual({
      kind: AGENT_EVENT_KINDS.RESULT,
      ok: false,
      text: "boom",
    });
    expect(normalizeCodexEvent({ type: "error", error: { message: "nope" } }).text).toBe("nope");
    expect(normalizeCodexEvent({ type: "error" }).text).toBe("Codex run failed.");
  });
  it("agent_message completed -> assistant text; started -> ignored", () => {
    expect(normalizeCodexEvent({ type: "item.completed", item: { type: "agent_message", text: "hi" } })).toEqual({
      kind: AGENT_EVENT_KINDS.ASSISTANT,
      text: "hi",
      tools: [],
    });
    expect(normalizeCodexEvent({ type: "item.completed", item: { type: "agent_message" } }).text).toBe("");
    expect(normalizeCodexEvent({ type: "item.started", item: { type: "agent_message" } }).kind).toBe(
      AGENT_EVENT_KINDS.UNKNOWN,
    );
  });
  it("command_execution -> tool activity on start, tool-result on completion", () => {
    const started = normalizeCodexEvent({ type: "item.started", item: { type: "command_execution" } });
    expect(started).toEqual({ kind: AGENT_EVENT_KINDS.ASSISTANT, text: "", tools: [{ name: "command" }] });
    expect(eventToFeedEntry(started).label).toBe("Using command"); // reuses the shared feed mapper
    expect(normalizeCodexEvent({ type: "item.completed", item: { type: "command_execution" } })).toEqual({
      kind: AGENT_EVENT_KINDS.TOOL_RESULT,
    });
  });
  it("unknown item types and top-level types + non-objects -> UNKNOWN (tolerated)", () => {
    expect(normalizeCodexEvent({ type: "item.completed", item: { type: "reasoning" } })).toEqual({
      kind: AGENT_EVENT_KINDS.UNKNOWN,
      type: "reasoning",
    });
    expect(normalizeCodexEvent({ type: "item.completed", item: {} }).type).toBeNull();
    expect(normalizeCodexEvent({ type: "item.completed" })).toEqual({ kind: AGENT_EVENT_KINDS.UNKNOWN, type: null }); // no item field
    expect(normalizeCodexEvent({ type: "weird" })).toEqual({ kind: AGENT_EVENT_KINDS.UNKNOWN, type: "weird" });
    expect(normalizeCodexEvent({ type: 5 }).type).toBeNull();
    expect(normalizeCodexEvent(null)).toEqual({ kind: AGENT_EVENT_KINDS.UNKNOWN, type: "null" });
  });
});

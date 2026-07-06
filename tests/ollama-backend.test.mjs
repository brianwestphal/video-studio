import { describe, it, expect } from "vitest";
import {
  OLLAMA_CAPABILITIES,
  OLLAMA_TOOLS,
  OLLAMA_MAX_STEPS,
  buildOllamaMessages,
  parseModelReply,
  nextLoopAction,
  toolResultMessage,
} from "../desktop/sidecar/ollama-backend.mjs";

describe("ollama-backend — capabilities + catalog", () => {
  it("advertises the reduced feature set (R-CB1/R-CB5/R-CB11)", () => {
    expect(OLLAMA_CAPABILITIES).toMatchObject({
      backend: "ollama",
      nativeSession: false,
      nativeToolUse: false,
      permissionCallback: true,
      auth: "none",
    });
    expect(Object.isFrozen(OLLAMA_CAPABILITIES)).toBe(true);
  });
  it("offers a curated tool catalog", () => {
    expect(OLLAMA_TOOLS.map((t) => t.name)).toEqual(["read_file", "propose_baseline"]);
  });
});

describe("ollama-backend — buildOllamaMessages", () => {
  it("builds a system prompt with the tool catalog + folder, then the user intent", () => {
    const msgs = buildOllamaMessages("punchy 15s cut", "/proj");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("/proj");
    expect(msgs[0].content).toContain("read_file:");
    expect(msgs[0].content).toContain('{ "tool":');
    expect(msgs[1]).toEqual({ role: "user", content: "punchy 15s cut" });
  });
  it("tolerates a nullish prompt", () => {
    expect(buildOllamaMessages(null, "/p")[1].content).toBe("");
  });
});

describe("ollama-backend — parseModelReply", () => {
  it("recognizes a known tool request (fenced or bare), defaulting input to {}", () => {
    expect(parseModelReply('```json\n{ "tool": "read_file", "input": { "path": "multicam.json" } }\n```')).toEqual({
      kind: "tool",
      tool: "read_file",
      input: { path: "multicam.json" },
    });
    expect(parseModelReply('{ "tool": "propose_baseline" }')).toEqual({ kind: "tool", tool: "propose_baseline", input: {} });
  });
  it("treats an unknown tool or a plain answer as final", () => {
    expect(parseModelReply('{ "tool": "rm_rf", "input": {} }').kind).toBe("final"); // unknown tool -> final
    const fin = parseModelReply('{ "switches": [ { "atSeconds": 0, "memberId": "cam1" } ] }');
    expect(fin.kind).toBe("final");
    expect(fin.text).toContain("switches");
    expect(parseModelReply("no json").kind).toBe("final");
    expect(parseModelReply(42)).toEqual({ kind: "final", text: "" });
  });
  it("a tool request with a non-object input falls back to {}", () => {
    expect(parseModelReply('{ "tool": "read_file", "input": "oops" }')).toEqual({ kind: "tool", tool: "read_file", input: {} });
  });
});

describe("ollama-backend — nextLoopAction", () => {
  it("executes a tool request under the step cap", () => {
    const reply = { kind: "tool", tool: "read_file", input: { path: "m.json" } };
    expect(nextLoopAction(reply, { step: 0 })).toEqual({ action: "execute", tool: "read_file", input: { path: "m.json" } });
  });
  it("stops when the step cap is reached instead of executing again", () => {
    const reply = { kind: "tool", tool: "read_file", input: {} };
    const out = nextLoopAction(reply, { step: OLLAMA_MAX_STEPS });
    expect(out.action).toBe("stop");
    expect(out.reason).toMatch(/cap/);
  });
  it("returns final for a final reply (and tolerates a nullish reply)", () => {
    expect(nextLoopAction({ kind: "final", text: "done" }, { step: 2 })).toEqual({ action: "final", text: "done" });
    expect(nextLoopAction(null, { step: 0 })).toEqual({ action: "final", text: "" });
  });
});

describe("ollama-backend — toolResultMessage", () => {
  it("feeds a string or object result back as a user turn", () => {
    expect(toolResultMessage("read_file", "file contents")).toEqual({ role: "user", content: "Result of read_file:\nfile contents" });
    expect(toolResultMessage("propose_baseline", { ok: true }).content).toContain('{"ok":true}');
  });
});

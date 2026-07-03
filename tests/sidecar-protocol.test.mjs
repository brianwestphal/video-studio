import { describe, it, expect } from "vitest";
import {
  MESSAGE_TYPES,
  ERROR_CODES,
  frameMessage,
  parseFrames,
  readyMessage,
  progressMessage,
  resultMessage,
  errorMessage,
  validateRequest,
} from "../desktop/sidecar/protocol.mjs";
import {
  TOOL_PATHS,
  toolArgv,
  parseAnalyzerProgress,
  genericProgress,
  STEP_REGISTRY,
} from "../desktop/sidecar/steps.mjs";

describe("protocol — framing", () => {
  it("frameMessage produces one NDJSON line", () => {
    expect(frameMessage({ a: 1 })).toBe('{"a":1}\n');
  });

  it("parseFrames splits complete lines and keeps the trailing partial", () => {
    const { messages, rest } = parseFrames('{"a":1}\n{"b":2}\n{"c":');
    expect(messages).toEqual([
      { ok: true, value: { a: 1 } },
      { ok: true, value: { b: 2 } },
    ]);
    expect(rest).toBe('{"c":');
  });

  it("parseFrames treats a buffer ending in newline as no remainder", () => {
    const { messages, rest } = parseFrames('{"a":1}\n');
    expect(messages).toEqual([{ ok: true, value: { a: 1 } }]);
    expect(rest).toBe("");
  });

  it("parseFrames skips blank/whitespace lines", () => {
    const { messages } = parseFrames('\n   \n{"a":1}\n');
    expect(messages).toEqual([{ ok: true, value: { a: 1 } }]);
  });

  it("parseFrames reports a malformed line without poisoning the rest", () => {
    const { messages } = parseFrames('{"a":1}\nnot json\n{"b":2}\n');
    expect(messages[0]).toEqual({ ok: true, value: { a: 1 } });
    expect(messages[1].ok).toBe(false);
    expect(messages[1].raw).toBe("not json");
    expect(typeof messages[1].error).toBe("string");
    expect(messages[2]).toEqual({ ok: true, value: { b: 2 } });
  });

  it("parseFrames tolerates nullish input", () => {
    expect(parseFrames(undefined)).toEqual({ messages: [], rest: "" });
    expect(parseFrames(null)).toEqual({ messages: [], rest: "" });
  });
});

describe("protocol — host→shell constructors", () => {
  it("readyMessage", () => {
    expect(readyMessage()).toEqual({ type: MESSAGE_TYPES.READY });
  });
  it("progressMessage", () => {
    expect(progressMessage("id1", { stage: "detect" })).toEqual({
      type: "progress",
      id: "id1",
      progress: { stage: "detect" },
    });
  });
  it("resultMessage", () => {
    expect(resultMessage(7, { ok: true })).toEqual({ type: "result", id: 7, data: { ok: true } });
  });
  it("errorMessage", () => {
    expect(errorMessage("id2", ERROR_CODES.STEP_FAILED, "boom")).toEqual({
      type: "error",
      id: "id2",
      error: { code: "step_failed", message: "boom" },
    });
  });
});

describe("protocol — validateRequest", () => {
  it("rejects null / non-object / array messages", () => {
    for (const bad of [null, 42, "str", []]) {
      const r = validateRequest(bad, STEP_REGISTRY);
      expect(r.ok).toBe(false);
      expect(r.code).toBe(ERROR_CODES.BAD_REQUEST);
      expect(r.id).toBe(null);
    }
  });

  it("accepts a cancel with a valid id", () => {
    expect(validateRequest({ type: "cancel", id: "a" }, STEP_REGISTRY)).toEqual({
      ok: true,
      kind: MESSAGE_TYPES.CANCEL,
      id: "a",
    });
  });

  it("rejects a cancel with no valid id", () => {
    const r = validateRequest({ type: "cancel" }, STEP_REGISTRY);
    expect(r).toMatchObject({ ok: false, id: null, code: ERROR_CODES.BAD_REQUEST });
  });

  it("rejects an unsupported message type, echoing a present id", () => {
    const r = validateRequest({ type: "frobnicate", id: "x" }, STEP_REGISTRY);
    expect(r).toMatchObject({ ok: false, id: "x", code: ERROR_CODES.BAD_REQUEST });
    expect(r.message).toContain("frobnicate");
  });

  it("rejects a request with no valid id", () => {
    const r = validateRequest({ type: "request", step: "analyze-scenes" }, STEP_REGISTRY);
    expect(r).toMatchObject({ ok: false, id: null, code: ERROR_CODES.BAD_REQUEST });
  });

  it("rejects a request missing / empty step name", () => {
    expect(validateRequest({ type: "request", id: "a" }, STEP_REGISTRY).code).toBe(ERROR_CODES.BAD_REQUEST);
    expect(validateRequest({ type: "request", id: "a", step: "" }, STEP_REGISTRY).code).toBe(ERROR_CODES.BAD_REQUEST);
  });

  it("rejects an unknown step (and when the registry is absent)", () => {
    expect(validateRequest({ type: "request", id: "a", step: "nope" }, STEP_REGISTRY)).toMatchObject({
      ok: false,
      id: "a",
      code: ERROR_CODES.UNKNOWN_STEP,
    });
    expect(validateRequest({ type: "request", id: "a", step: "analyze-scenes" }, null).code).toBe(
      ERROR_CODES.UNKNOWN_STEP,
    );
  });

  it("rejects a missing required param (absent or empty)", () => {
    expect(
      validateRequest({ type: "request", id: 1, step: "analyze-scenes", params: {} }, STEP_REGISTRY),
    ).toMatchObject({ ok: false, code: ERROR_CODES.MISSING_PARAM });
    expect(
      validateRequest({ type: "request", id: 1, step: "analyze-scenes", params: { video: "" } }, STEP_REGISTRY).code,
    ).toBe(ERROR_CODES.MISSING_PARAM);
  });

  it("treats a non-object params as empty (array included)", () => {
    const r = validateRequest({ type: "request", id: 1, step: "analyze-scenes", params: [] }, STEP_REGISTRY);
    expect(r).toMatchObject({ ok: false, code: ERROR_CODES.MISSING_PARAM });
  });

  it("normalizes a valid request", () => {
    expect(
      validateRequest({ type: "request", id: 3, step: "analyze-scenes", params: { video: "v.mp4" } }, STEP_REGISTRY),
    ).toEqual({ ok: true, kind: MESSAGE_TYPES.REQUEST, id: 3, step: "analyze-scenes", params: { video: "v.mp4" } });
  });

  it("accepts a step with no requiredParams", () => {
    const registry = { ping: { buildCommand: () => ({ tool: "x", args: [] }) } };
    expect(validateRequest({ type: "request", id: 1, step: "ping" }, registry)).toEqual({
      ok: true,
      kind: MESSAGE_TYPES.REQUEST,
      id: 1,
      step: "ping",
      params: {},
    });
  });

  it("id validity: finite number ok, NaN / boolean / empty-string not", () => {
    expect(validateRequest({ type: "cancel", id: 5 }, STEP_REGISTRY).ok).toBe(true);
    expect(validateRequest({ type: "cancel", id: Number.NaN }, STEP_REGISTRY).id).toBe(null);
    expect(validateRequest({ type: "request", id: true, step: "analyze-scenes" }, STEP_REGISTRY).id).toBe(null);
    expect(validateRequest({ type: "cancel", id: "" }, STEP_REGISTRY).id).toBe(null);
  });
});

describe("steps — tool resolution", () => {
  it("TOOL_PATHS maps the known tools", () => {
    expect(TOOL_PATHS.analyzer).toBe("dist/analyzer.js");
  });
  it("toolArgv resolves a known tool under the repo root", () => {
    expect(toolArgv("analyzer", "/repo")).toEqual(["node", "/repo/dist/analyzer.js"]);
  });
  it("toolArgv throws on an unknown tool", () => {
    expect(() => toolArgv("mystery", "/repo")).toThrow(/unknown tool/);
  });
});

describe("steps — analyzer progress parsing", () => {
  it("returns null for empty/nullish lines", () => {
    expect(parseAnalyzerProgress("")).toBe(null);
    expect(parseAnalyzerProgress("   ")).toBe(null);
    expect(parseAnalyzerProgress(null)).toBe(null);
  });
  it("parses the 'Detected N scene(s)' line", () => {
    expect(parseAnalyzerProgress("Detected 42 scene(s) at 24fps across 00:01:23:12.")).toMatchObject({
      stage: "detected",
      total: 42,
    });
  });
  it("parses the 'Resuming' line", () => {
    expect(parseAnalyzerProgress("Resuming: 42 scene(s) already detected, 10 already described.")).toMatchObject({
      stage: "resume",
      total: 42,
      done: 10,
    });
  });
  it("parses the per-scene 'Scene i/N' line", () => {
    expect(parseAnalyzerProgress("Scene 3/42 [00:00:05:00 - 00:00:07:12]...")).toMatchObject({
      stage: "describe",
      current: 3,
      total: 42,
    });
  });
  it("parses the 'Detecting scene boundaries' + 'Extracting' lines", () => {
    expect(parseAnalyzerProgress("Detecting scene boundaries (threshold 0.4)...").stage).toBe("detect");
    expect(parseAnalyzerProgress("Extracting one representative frame per scene...").stage).toBe("extract");
  });
  it("falls back to a log stage for any other line", () => {
    expect(parseAnalyzerProgress("something else entirely")).toEqual({
      stage: "log",
      message: "something else entirely",
    });
  });
});

describe("steps — genericProgress", () => {
  it("returns null for empty/nullish and a log entry otherwise", () => {
    expect(genericProgress("   ")).toBe(null);
    expect(genericProgress(null)).toBe(null);
    expect(genericProgress("hello")).toEqual({ stage: "log", message: "hello" });
  });
});

describe("steps — buildCommand descriptors", () => {
  it("analyze-scenes: minimal vs fully-optioned", () => {
    expect(STEP_REGISTRY["analyze-scenes"].buildCommand({ video: "v.mp4" })).toEqual({
      tool: "analyzer",
      args: ["v.mp4"],
    });
    expect(
      STEP_REGISTRY["analyze-scenes"].buildCommand({ video: "v.mp4", out: "t.json", describe: "ollama", model: "m" }),
    ).toEqual({ tool: "analyzer", args: ["v.mp4", "--out", "t.json", "--describe", "ollama", "--model", "m"] });
  });

  it("analyze-audio-events: minimal vs with --out", () => {
    expect(STEP_REGISTRY["analyze-audio-events"].buildCommand({ video: "v.mp4" })).toEqual({
      tool: "audio-events",
      args: ["v.mp4"],
    });
    expect(STEP_REGISTRY["analyze-audio-events"].buildCommand({ video: "v.mp4", out: "a.json" })).toEqual({
      tool: "audio-events",
      args: ["v.mp4", "--out", "a.json"],
    });
  });

  it("analyze-sources: array inputs, single input, and --out", () => {
    expect(STEP_REGISTRY["analyze-sources"].buildCommand({ inputs: ["a.mp4", "b.mp4"] })).toEqual({
      tool: "sources",
      args: ["a.mp4", "b.mp4"],
    });
    expect(STEP_REGISTRY["analyze-sources"].buildCommand({ inputs: "a.mp4", out: "s.json" })).toEqual({
      tool: "sources",
      args: ["a.mp4", "--out", "s.json"],
    });
  });

  it("each step exposes a progress parser", () => {
    expect(STEP_REGISTRY["analyze-scenes"].parseProgress).toBe(parseAnalyzerProgress);
    expect(STEP_REGISTRY["analyze-audio-events"].parseProgress).toBe(genericProgress);
  });
});

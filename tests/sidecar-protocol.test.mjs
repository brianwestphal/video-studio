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
  EXPORT_KINDS,
  exportCommand,
  reviewCommand,
  parseReviewUrl,
  proposeCommand,
  videoFilesIn,
  importCommand,
} from "../desktop/sidecar/steps.mjs";
import { DOCTOR_TOOLS, doctorResultFromChecks } from "../desktop/sidecar/doctor.mjs";
import {
  ARTIFACTS,
  presentArtifacts,
  deriveStages,
  newProjectState,
  reconcileProject,
} from "../desktop/sidecar/project.mjs";
import {
  AGENT_EVENT_KINDS,
  normalizeClaudeEvent,
  eventToFeedEntry,
  validateCutPlan,
  isAuthFailure,
} from "../desktop/sidecar/agent.mjs";
import {
  CATEGORIES,
  DEFAULT_POLICY,
  isInProject,
  classifyToolCall,
  matchRule,
  decide,
  deriveAllowedTools,
} from "../desktop/sidecar/permissions.mjs";
import {
  emptyConfig,
  parseConfig,
  addRecentProject,
  addRule,
  revokeRule,
  resetRules,
  setCategoryPolicy,
  effectivePolicy,
  serializeConfig,
} from "../desktop/sidecar/config.mjs";

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

describe("steps — exportCommand", () => {
  it("mp4: 16:9 render over multicam + switches, into exports/", () => {
    expect(exportCommand("mp4", "/proj", { hasSwitches: true })).toEqual({
      tool: "render-preview",
      args: [
        "/proj/multicam.json",
        "--width",
        "1280",
        "--height",
        "720",
        "--switches",
        "/proj/switches.json",
        "--out",
        "/proj/exports/cut.mp4",
      ],
      outPath: "/proj/exports/cut.mp4",
    });
  });
  it("social: vertical 1080x1920 on the same renderer", () => {
    const c = exportCommand("social", "/proj");
    expect(c.tool).toBe("render-preview");
    expect(c.args).toContain("1080");
    expect(c.args).toContain("1920");
    expect(c.outPath).toBe("/proj/exports/cut.9x16.mp4");
  });
  it("fcpxml: the FCP handoff tool; omits --switches when absent", () => {
    const c = exportCommand("fcpxml", "/proj", { hasSwitches: false });
    expect(c.tool).toBe("fcpxml");
    expect(c.args).not.toContain("--switches");
    expect(c.outPath).toBe("/proj/exports/cut.fcpxml");
  });
  it("every EXPORT_KINDS entry resolves; unknown kind throws", () => {
    for (const kind of Object.keys(EXPORT_KINDS)) {
      expect(exportCommand(kind, "/p").outPath).toContain("/p/exports/");
    }
    expect(() => exportCommand("nope", "/p")).toThrow(/unknown export kind/);
  });
});

describe("steps — reviewCommand + parseReviewUrl", () => {
  it("builds the review server argv (default port, no optional artifacts)", () => {
    expect(reviewCommand("/proj")).toEqual({
      tool: "review",
      args: ["/proj/multicam.json", "--switches", "/proj/switches.json", "--no-open", "--port", "8777"],
    });
  });
  it("includes audio-events + saliency + a custom port when given", () => {
    const c = reviewCommand("/proj", { hasAudioEvents: true, hasSaliency: true, port: 9000 });
    expect(c.args).toEqual([
      "/proj/multicam.json",
      "--switches",
      "/proj/switches.json",
      "--no-open",
      "--port",
      "9000",
      "--audio-events",
      "/proj/audio-events.json",
      "--saliency",
      "/proj/saliency.json",
    ]);
  });
  it("parseReviewUrl extracts the URL from the startup line, else null", () => {
    expect(parseReviewUrl("Review UI at http://127.0.0.1:8777/ — pick angles for 3 cut(s)…")).toBe(
      "http://127.0.0.1:8777/",
    );
    expect(parseReviewUrl("some other line")).toBe(null);
    expect(parseReviewUrl(null)).toBe(null);
  });
});

describe("steps — videoFilesIn + importCommand", () => {
  it("videoFilesIn filters + sorts video files (case-insensitive), ignoring the rest", () => {
    expect(videoFilesIn(["b.MOV", "notes.txt", "a.mp4", "multicam.json", "c.mkv"])).toEqual([
      "a.mp4",
      "b.MOV",
      "c.mkv",
    ]);
    expect(videoFilesIn(null)).toEqual([]);
  });
  it("one video → analyze-sources → sources.json (single)", () => {
    expect(importCommand("/proj", ["clip.mp4", "readme.md"])).toEqual({
      tool: "sources",
      args: ["/proj/clip.mp4", "--out", "/proj/sources.json"],
      outPath: "/proj/sources.json",
      kind: "single",
      count: 1,
    });
  });
  it("two+ videos → sync-multicam → multicam.json (multi-cam)", () => {
    const c = importCommand("/proj", ["cam2.mov", "cam1.mp4", "cam3.mkv"]);
    expect(c).toMatchObject({ tool: "sync", outPath: "/proj/multicam.json", kind: "multicam", count: 3 });
    // sorted, absolute, with --out last
    expect(c.args).toEqual(["/proj/cam1.mp4", "/proj/cam2.mov", "/proj/cam3.mkv", "--out", "/proj/multicam.json"]);
  });
  it("no videos → throws", () => {
    expect(() => importCommand("/proj", ["readme.md"])).toThrow(/no video files/);
  });
});

describe("steps — proposeCommand", () => {
  it("builds propose-switches argv → switches.json (bare)", () => {
    expect(proposeCommand("/proj")).toEqual({
      tool: "propose-switches",
      args: ["/proj/multicam.json", "--out", "/proj/switches.json"],
      outPath: "/proj/switches.json",
    });
  });
  it("adds audio-events + saliency when present", () => {
    expect(proposeCommand("/proj", { hasAudioEvents: true, hasSaliency: true }).args).toEqual([
      "/proj/multicam.json",
      "--audio-events",
      "/proj/audio-events.json",
      "--saliency",
      "/proj/saliency.json",
      "--out",
      "/proj/switches.json",
    ]);
  });
});

describe("doctor — doctorResultFromChecks", () => {
  it("all tools found → ready, no missing", () => {
    const found = Object.fromEntries(DOCTOR_TOOLS.map((t) => [t.key, true]));
    const r = doctorResultFromChecks(found);
    expect(r.ready).toBe(true);
    expect(r.missingRequired).toEqual([]);
    expect(r.rows.every((row) => row.status === "ok")).toBe(true);
    expect(r.rows).toHaveLength(DOCTOR_TOOLS.length);
  });

  it("a missing required tool → not ready and listed", () => {
    const found = Object.fromEntries(DOCTOR_TOOLS.map((t) => [t.key, t.key !== "ffmpeg"]));
    const r = doctorResultFromChecks(found);
    expect(r.ready).toBe(false);
    expect(r.missingRequired).toEqual(["ffmpeg"]);
    expect(r.rows.find((row) => row.key === "ffmpeg").status).toBe("missing-required");
  });

  it("a missing optional tool → still ready, status missing-optional", () => {
    const found = Object.fromEntries(DOCTOR_TOOLS.map((t) => [t.key, t.key !== "ollama"]));
    const r = doctorResultFromChecks(found);
    expect(r.ready).toBe(true);
    expect(r.rows.find((row) => row.key === "ollama").status).toBe("missing-optional");
  });

  it("nullish / non-object checks → everything missing", () => {
    const r = doctorResultFromChecks(null);
    expect(r.ready).toBe(false);
    expect(r.rows.every((row) => row.found === false)).toBe(true);
    // required tools show up as missing-required
    expect(r.missingRequired).toEqual(DOCTOR_TOOLS.filter((t) => t.required).map((t) => t.key));
  });

  it("accepts a custom tool list", () => {
    const tools = [{ key: "x", label: "X", required: true, hint: "h" }];
    expect(doctorResultFromChecks({ x: true }, tools)).toEqual({
      ready: true,
      missingRequired: [],
      rows: [{ key: "x", label: "X", required: true, hint: "h", found: true, status: "ok" }],
    });
  });
});

describe("project — presentArtifacts", () => {
  it("maps filenames to artifact keys", () => {
    const present = presentArtifacts([ARTIFACTS.sources, ARTIFACTS.switches, "unrelated.txt"]);
    expect(present.has("sources")).toBe(true);
    expect(present.has("switches")).toBe(true);
    expect(present.has("multicam")).toBe(false);
  });
  it("tolerates a non-array listing", () => {
    expect(presentArtifacts(null).size).toBe(0);
  });
});

describe("project — deriveStages", () => {
  const byKey = (stages) => Object.fromEntries(stages.map((s) => [s.key, s.state]));

  it("empty project: setup active, new-project idle, downstream locked", () => {
    const st = byKey(deriveStages([]));
    expect(st.setup).toBe("active");
    expect(st["new-project"]).toBe("idle");
    expect(st.analyze).toBe("locked");
    expect(st.design).toBe("locked");
  });

  it("footage present completes new-project and unlocks analyze (setup stays the default active)", () => {
    const st = byKey(deriveStages([ARTIFACTS.multicam]));
    expect(st.setup).toBe("active"); // never-done setup is the default active
    expect(st["new-project"]).toBe("done");
    expect(st.analyze).toBe("idle"); // unlocked (new-project done), not active, not done
  });

  it("accepts a Set of artifact keys directly", () => {
    const st = byKey(deriveStages(new Set(["sources"])));
    expect(st["new-project"]).toBe("done");
    expect(st.analyze).toBe("idle");
    expect(st.design).toBe("locked"); // analyze not done
  });

  it("a selected reachable stage becomes active; done stages show done", () => {
    const st = byKey(deriveStages(new Set(["sources", "audioEvents"]), "setup"));
    expect(st.setup).toBe("active");
    expect(st["new-project"]).toBe("done");
    expect(st.analyze).toBe("done");
    expect(st.design).toBe("idle"); // reachable (analyze done), not active, not done
    expect(st.review).toBe("locked");
  });

  it("a selected but locked stage is ignored (falls back to first actionable)", () => {
    const st = byKey(deriveStages(new Set([]), "export")); // export is locked
    expect(st.export).toBe("locked");
    expect(st.setup).toBe("active"); // fell back
  });

  it("full pipeline: every stage done except the never-done setup", () => {
    const all = new Set(["sources", "audioEvents", "switches", "switchesHistory", "exports"]);
    const st = byKey(deriveStages(all, null));
    expect(st.setup).toBe("active"); // setup is never done → first actionable
    expect(st.design).toBe("done");
    expect(st.review).toBe("done");
    expect(st.export).toBe("done");
  });
});

describe("project — newProjectState", () => {
  it("builds a fresh state, defaulting name + sources", () => {
    expect(newProjectState("My Show", ["a.mp4"])).toEqual({ name: "My Show", sources: ["a.mp4"], artifacts: [] });
    expect(newProjectState()).toEqual({ name: "Untitled", sources: [], artifacts: [] });
    expect(newProjectState("X", "not-array")).toEqual({ name: "X", sources: [], artifacts: [] });
  });
});

describe("project — reconcileProject", () => {
  it("re-derives artifacts from disk (filesystem wins) + keeps saved name/sources", () => {
    const saved = { name: "Gig", sources: ["cam1.mp4"], artifacts: ["stale"] };
    const r = reconcileProject(saved, [ARTIFACTS.sources, ARTIFACTS.audioEvents]);
    expect(r).toEqual({ name: "Gig", sources: ["cam1.mp4"], artifacts: ["audioEvents", "sources"] });
  });

  it("missing/corrupt saved state degrades to the folder name", () => {
    expect(reconcileProject(null, [], "MyFolder")).toEqual({ name: "MyFolder", sources: [], artifacts: [] });
    expect(reconcileProject([1, 2], [], "F")).toEqual({ name: "F", sources: [], artifacts: [] });
  });

  it("empty saved name falls back to the folder name; non-array sources → []", () => {
    expect(reconcileProject({ name: "", sources: "x" }, [], "Fallback")).toEqual({
      name: "Fallback",
      sources: [],
      artifacts: [],
    });
  });
});

describe("agent — normalizeClaudeEvent", () => {
  it("nullish / non-object → unknown", () => {
    expect(normalizeClaudeEvent(null)).toEqual({ kind: "unknown", type: "null" });
    expect(normalizeClaudeEvent("x")).toEqual({ kind: "unknown", type: "x" });
  });
  it("system/init → session (id present or null)", () => {
    expect(normalizeClaudeEvent({ type: "system", subtype: "init", session_id: "s1" })).toEqual({
      kind: AGENT_EVENT_KINDS.SESSION,
      sessionId: "s1",
    });
    expect(normalizeClaudeEvent({ type: "system", subtype: "init" }).sessionId).toBe(null);
  });
  it("other system subtypes → system (subtype or null)", () => {
    expect(normalizeClaudeEvent({ type: "system", subtype: "compact" })).toEqual({ kind: "system", subtype: "compact" });
    expect(normalizeClaudeEvent({ type: "system" }).subtype).toBe(null);
  });
  it("assistant → text + tools, skipping other/blank content parts", () => {
    const ev = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
          { type: "tool_use", name: "analyze-scenes", input: { video: "v" } },
          { type: "image" },
          null,
        ],
      },
    };
    expect(normalizeClaudeEvent(ev)).toEqual({
      kind: "assistant",
      text: "Hello world",
      tools: [{ name: "analyze-scenes", input: { video: "v" } }],
    });
  });
  it("assistant with no/blank content → empty text + tools; tool_use defaults", () => {
    expect(normalizeClaudeEvent({ type: "assistant" })).toEqual({ kind: "assistant", text: "", tools: [] });
    expect(normalizeClaudeEvent({ type: "assistant", message: { content: [{ type: "tool_use" }] } })).toEqual({
      kind: "assistant",
      text: "",
      tools: [{ name: "", input: {} }],
    });
  });
  it("user → tool-result; result → ok/text/subtype", () => {
    expect(normalizeClaudeEvent({ type: "user" })).toEqual({ kind: "tool-result" });
    expect(normalizeClaudeEvent({ type: "result", subtype: "success", result: "ok", is_error: false })).toEqual({
      kind: "result",
      ok: true,
      text: "ok",
      subtype: "success",
    });
    expect(normalizeClaudeEvent({ type: "result", is_error: true })).toMatchObject({ ok: false, text: "" });
  });
  it("unknown types → unknown with a string type or null", () => {
    expect(normalizeClaudeEvent({ type: "weird" })).toEqual({ kind: "unknown", type: "weird" });
    expect(normalizeClaudeEvent({ type: 42 })).toEqual({ kind: "unknown", type: null });
    expect(normalizeClaudeEvent({})).toEqual({ kind: "unknown", type: null });
  });
});

describe("agent — eventToFeedEntry", () => {
  it("session / system", () => {
    expect(eventToFeedEntry({ kind: "session", sessionId: "s1" })).toEqual({ label: "Session started", detail: "s1" });
    expect(eventToFeedEntry({ kind: "session" })).toEqual({ label: "Session started", detail: "" });
    expect(eventToFeedEntry({ kind: "system", subtype: "compact" })).toEqual({ label: "System", detail: "compact" });
    expect(eventToFeedEntry({ kind: "system" })).toEqual({ label: "System", detail: "" });
  });
  it("assistant: friendly tool label, raw tool label, text, or skip", () => {
    expect(eventToFeedEntry({ kind: "assistant", tools: [{ name: "analyze-scenes" }], text: "" }).label).toBe(
      "Analyzing scenes",
    );
    expect(eventToFeedEntry({ kind: "assistant", tools: [{ name: "mystery" }], text: "" }).label).toBe("Using mystery");
    expect(eventToFeedEntry({ kind: "assistant", tools: [], text: "hi" })).toEqual({ label: "Claude", detail: "hi" });
    expect(eventToFeedEntry({ kind: "assistant", tools: [], text: "" })).toBe(null);
  });
  it("tool-result → null; result → Done/Failed; unknown → null; null → null", () => {
    expect(eventToFeedEntry({ kind: "tool-result" })).toBe(null);
    expect(eventToFeedEntry({ kind: "result", ok: true, text: "d" })).toEqual({ label: "Done", detail: "d" });
    expect(eventToFeedEntry({ kind: "result", ok: false })).toEqual({ label: "Failed", detail: "" });
    expect(eventToFeedEntry({ kind: "unknown" })).toBe(null);
    expect(eventToFeedEntry(null)).toBe(null);
  });
});

describe("agent — validateCutPlan", () => {
  it("rejects non-objects + a missing switches array", () => {
    expect(validateCutPlan(null).ok).toBe(false);
    expect(validateCutPlan([]).ok).toBe(false);
    expect(validateCutPlan(5).ok).toBe(false);
    expect(validateCutPlan({}).error).toMatch(/switches array/);
  });
  it("rejects malformed switches", () => {
    expect(validateCutPlan({ switches: [null] }).error).toMatch(/switch 0 is not an object/);
    expect(validateCutPlan({ switches: [{ atSeconds: "x", memberId: "a" }] }).error).toMatch(/atSeconds/);
    expect(validateCutPlan({ switches: [{ atSeconds: -1, memberId: "a" }] }).error).toMatch(/atSeconds/);
    expect(validateCutPlan({ switches: [{ atSeconds: Number.NaN, memberId: "a" }] }).error).toMatch(/atSeconds/);
    expect(validateCutPlan({ switches: [{ atSeconds: 1 }] }).error).toMatch(/memberId/);
    expect(validateCutPlan({ switches: [{ atSeconds: 1, memberId: "" }] }).error).toMatch(/memberId/);
  });
  it("accepts + normalizes (sorted by atSeconds)", () => {
    expect(
      validateCutPlan({ switches: [{ atSeconds: 5, memberId: "b" }, { atSeconds: 1, memberId: "a" }], extra: 1 }),
    ).toEqual({ ok: true, plan: { switches: [{ atSeconds: 1, memberId: "a" }, { atSeconds: 5, memberId: "b" }] } });
  });
});

describe("agent — isAuthFailure", () => {
  it("true only for a failed result whose text names an auth problem", () => {
    expect(isAuthFailure({ kind: "result", ok: false, text: "Not logged in — run setup-token" })).toBe(true);
    expect(isAuthFailure({ kind: "result", ok: false, text: "401 Unauthorized" })).toBe(true);
    expect(isAuthFailure({ kind: "result", ok: false, text: "ffmpeg not found" })).toBe(false);
    expect(isAuthFailure({ kind: "result", ok: false })).toBe(false); // no text
    expect(isAuthFailure({ kind: "result", ok: true, text: "auth ok" })).toBe(false);
    expect(isAuthFailure({ kind: "assistant" })).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});

const ROOT = "/Users/x/proj";

describe("permissions — isInProject (pure path containment)", () => {
  it("in-project + exact root are inside", () => {
    expect(isInProject(`${ROOT}/a/b.json`, ROOT)).toBe(true);
    expect(isInProject(ROOT, ROOT)).toBe(true);
  });
  it("outside + traversal escapes read as outside", () => {
    expect(isInProject("/etc/passwd", ROOT)).toBe(false);
    expect(isInProject(`${ROOT}/../secret`, ROOT)).toBe(false); // .. pops back out
    expect(isInProject("/../etc", "/")).toBe(false); // .. above root is a no-op → "/etc" (root "/")...
  });
  it("falsy inputs are outside; relative paths normalize without escaping", () => {
    expect(isInProject("", ROOT)).toBe(false);
    expect(isInProject(`${ROOT}/x`, "")).toBe(false);
    expect(isInProject("../x", "rel")).toBe(false); // leading .. kept (relative)
    expect(isInProject("../../x", "rel")).toBe(false); // accumulating ..
  });
});

describe("permissions — classifyToolCall", () => {
  it("our pipeline tools + engine commands → media-processing", () => {
    expect(classifyToolCall("analyze-scenes", {}, ROOT)).toBe(CATEGORIES.MEDIA);
    expect(classifyToolCall("Bash", { command: "ffmpeg -i a.mp4 out.mp4" }, ROOT)).toBe(CATEGORIES.MEDIA);
    expect(classifyToolCall("Bash", { command: "/opt/homebrew/bin/ffprobe a.mp4" }, ROOT)).toBe(CATEGORIES.MEDIA);
    expect(classifyToolCall("Bash", { command: "node /r/dist/analyzer.js clip.mp4" }, ROOT)).toBe(CATEGORIES.MEDIA);
    expect(classifyToolCall("Bash", { command: "node tools/propose-switches.mjs" }, ROOT)).toBe(CATEGORIES.MEDIA);
  });
  it("destructive + egress shell", () => {
    expect(classifyToolCall("Bash", { command: "rm -rf build" }, ROOT)).toBe(CATEGORIES.DESTRUCTIVE);
    expect(classifyToolCall("Bash", { command: "echo hi > /etc/hosts" }, ROOT)).toBe(CATEGORIES.DESTRUCTIVE);
    expect(classifyToolCall("Bash", { command: "mv a b" }, ROOT)).toBe(CATEGORIES.DESTRUCTIVE);
    expect(classifyToolCall("Bash", { command: "curl https://x.com" }, ROOT)).toBe(CATEGORIES.EGRESS);
    expect(classifyToolCall("Bash", { command: "git push origin main" }, ROOT)).toBe(CATEGORIES.EGRESS);
  });
  it("plain shell + node-non-pipeline + empty command → other-shell", () => {
    expect(classifyToolCall("Bash", { command: "echo hello" }, ROOT)).toBe(CATEGORIES.SHELL);
    expect(classifyToolCall("Bash", { command: "node server.js" }, ROOT)).toBe(CATEGORIES.SHELL);
    expect(classifyToolCall("Bash", {}, ROOT)).toBe(CATEGORIES.SHELL);
  });
  it("read tools: in-project → read, outside → other-shell", () => {
    expect(classifyToolCall("Read", { file_path: `${ROOT}/a.json` }, ROOT)).toBe(CATEGORIES.READ);
    expect(classifyToolCall("Grep", { path: `${ROOT}/src` }, ROOT)).toBe(CATEGORIES.READ);
    expect(classifyToolCall("Read", { file_path: "/etc/passwd" }, ROOT)).toBe(CATEGORIES.SHELL);
    expect(classifyToolCall("Read", null, ROOT)).toBe(CATEGORIES.SHELL); // no path
  });
  it("write tools: in-project → write, outside → destructive", () => {
    expect(classifyToolCall("Write", { file_path: `${ROOT}/out.json` }, ROOT)).toBe(CATEGORIES.WRITE);
    expect(classifyToolCall("NotebookEdit", { notebook_path: `${ROOT}/n.ipynb` }, ROOT)).toBe(CATEGORIES.WRITE);
    expect(classifyToolCall("Edit", { path: `${ROOT}/y` }, ROOT)).toBe(CATEGORIES.WRITE); // path fallback
    expect(classifyToolCall("Write", { file_path: "/tmp/evil" }, ROOT)).toBe(CATEGORIES.DESTRUCTIVE);
  });
  it("network tools + unknown tools", () => {
    expect(classifyToolCall("WebFetch", { url: "x" }, ROOT)).toBe(CATEGORIES.EGRESS);
    expect(classifyToolCall("Mystery", {}, ROOT)).toBe(CATEGORIES.SHELL);
    expect(classifyToolCall(null, {}, ROOT)).toBe(CATEGORIES.SHELL);
  });
});

describe("permissions — matchRule (scope + precedence)", () => {
  const rule = (o) => ({ scope: "everywhere", decision: "allow", ...o });
  it("no rules / non-array → null", () => {
    expect(matchRule(CATEGORIES.SHELL, ROOT, null)).toBe(null);
    expect(matchRule(CATEGORIES.SHELL, ROOT, [])).toBe(null);
  });
  it("ignores non-matching category, null entries, and other-project scopes", () => {
    const rules = [null, rule({ category: CATEGORIES.MEDIA }), { category: CATEGORIES.SHELL, scope: "project", project: "/other", decision: "allow" }];
    expect(matchRule(CATEGORIES.SHELL, ROOT, rules)).toBe(null);
  });
  it("everywhere allow/deny; deny beats allow in the same tier", () => {
    expect(matchRule(CATEGORIES.EGRESS, ROOT, [rule({ category: CATEGORIES.EGRESS })])).toBe("allow");
    expect(
      matchRule(CATEGORIES.EGRESS, ROOT, [
        rule({ category: CATEGORIES.EGRESS, decision: "allow" }),
        rule({ category: CATEGORIES.EGRESS, decision: "deny" }),
      ]),
    ).toBe("deny");
  });
  it("a project-scoped rule beats an everywhere rule of the opposite decision", () => {
    const rules = [
      rule({ category: CATEGORIES.SHELL, decision: "deny" }), // everywhere deny
      { category: CATEGORIES.SHELL, scope: "project", project: ROOT, decision: "allow" }, // project allow wins
    ];
    expect(matchRule(CATEGORIES.SHELL, ROOT, rules)).toBe("allow");
  });
});

describe("permissions — decide (enforcement order)", () => {
  it("questions are never gated", () => {
    expect(decide("AskUserQuestion", {}, ROOT, [])).toBe("allow");
  });
  it("default policy applies on a rule miss (allow vs ask)", () => {
    expect(decide("analyze-scenes", {}, ROOT, [])).toBe("allow"); // media allowed
    expect(decide("Bash", { command: "curl x" }, ROOT, [])).toBe("ask"); // egress asks
    expect(decide(null, {}, ROOT, [])).toBe("ask"); // unknown → shell → ask
  });
  it("a persisted rule short-circuits the default", () => {
    const rules = [{ category: CATEGORIES.EGRESS, scope: "everywhere", decision: "allow" }];
    expect(decide("Bash", { command: "curl x" }, ROOT, rules)).toBe("allow");
    const deny = [{ category: CATEGORIES.MEDIA, scope: "everywhere", decision: "deny" }];
    expect(decide("analyze-scenes", {}, ROOT, deny)).toBe("deny");
  });
});

describe("permissions — deriveAllowedTools", () => {
  it("default policy pre-approves media + read + write tool names", () => {
    const allowed = deriveAllowedTools();
    expect(allowed).toContain("analyze-scenes");
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Write");
    expect(allowed).not.toContain("WebFetch");
  });
  it("a policy that asks for a category drops its tools", () => {
    const policy = { ...DEFAULT_POLICY, [CATEGORIES.READ]: "ask", [CATEGORIES.WRITE]: "ask", [CATEGORIES.MEDIA]: "ask" };
    expect(deriveAllowedTools(policy)).toEqual([]);
  });
});

describe("config — parseConfig (tolerant)", () => {
  it("nullish / non-object / array → empty config", () => {
    expect(parseConfig(null)).toEqual(emptyConfig());
    expect(parseConfig(42)).toEqual(emptyConfig());
    expect(parseConfig([1])).toEqual(emptyConfig());
  });
  it("keeps valid fields, drops junk", () => {
    const raw = {
      recentProjects: ["/a", "", 5, "/b"],
      agentBackend: "ollama",
      policy: { [CATEGORIES.MEDIA]: "ask", nope: "allow", [CATEGORIES.READ]: "bogus" },
      rules: [
        null,
        { category: "not-a-cat", scope: "everywhere", decision: "allow" },
        { category: CATEGORIES.EGRESS, scope: "sideways", decision: "allow" },
        { category: CATEGORIES.SHELL, scope: "project", decision: "allow" }, // missing project
        { category: CATEGORIES.SHELL, scope: "everywhere", decision: "maybe" },
        { category: CATEGORIES.EGRESS, scope: "everywhere", decision: "allow" },
        { category: CATEGORIES.WRITE, scope: "project", project: "/p", decision: "deny" },
      ],
    };
    expect(parseConfig(raw)).toEqual({
      version: 1,
      recentProjects: ["/a", "/b"],
      agentBackend: "ollama",
      policy: { [CATEGORIES.MEDIA]: "ask" },
      rules: [
        { category: CATEGORIES.EGRESS, scope: "everywhere", decision: "allow" },
        { category: CATEGORIES.WRITE, scope: "project", project: "/p", decision: "deny" },
      ],
    });
  });
  it("defaults agentBackend + non-array recents", () => {
    expect(parseConfig({ agentBackend: "", recentProjects: "x", policy: null })).toMatchObject({
      agentBackend: "claude",
      recentProjects: [],
      policy: {},
    });
  });
});

describe("config — recent projects", () => {
  it("adds to front, dedupes, and caps", () => {
    let c = emptyConfig();
    c = addRecentProject(c, "/a");
    c = addRecentProject(c, "/b");
    c = addRecentProject(c, "/a"); // moves to front
    expect(c.recentProjects).toEqual(["/a", "/b"]);
    c = addRecentProject(c, "/c", 2);
    expect(c.recentProjects).toEqual(["/c", "/a"]);
  });
  it("ignores an empty/non-string folder", () => {
    const c = emptyConfig();
    expect(addRecentProject(c, "")).toBe(c);
    expect(addRecentProject(c, 5)).toBe(c);
  });
});

describe("config — rules", () => {
  const rule = { category: CATEGORIES.EGRESS, scope: "everywhere", decision: "allow" };
  it("adds valid rules and ignores invalid ones", () => {
    let c = emptyConfig();
    c = addRule(c, rule);
    expect(c.rules).toEqual([rule]);
    expect(addRule(c, { category: "bad", scope: "everywhere", decision: "allow" })).toBe(c);
  });
  it("replaces a matching rule's decision, leaving other rules untouched", () => {
    const other = { category: CATEGORIES.SHELL, scope: "everywhere", decision: "deny" };
    let c = addRule(addRule(emptyConfig(), other), rule);
    c = addRule(c, { ...rule, decision: "deny" });
    expect(c.rules).toEqual([other, { ...rule, decision: "deny" }]);
  });
  it("keeps project-scoped rules distinct from everywhere ones", () => {
    let c = addRule(emptyConfig(), rule);
    c = addRule(c, { category: CATEGORIES.EGRESS, scope: "project", project: "/p", decision: "deny" });
    expect(c.rules).toHaveLength(2);
  });
  it("revokes by index (out-of-range = no-op) and resets all", () => {
    let c = addRule(addRule(emptyConfig(), rule), {
      category: CATEGORIES.SHELL,
      scope: "everywhere",
      decision: "deny",
    });
    expect(revokeRule(c, 5)).toBe(c);
    expect(revokeRule(c, -1)).toBe(c);
    expect(revokeRule(c, 1.5)).toBe(c);
    c = revokeRule(c, 0);
    expect(c.rules).toEqual([{ category: CATEGORIES.SHELL, scope: "everywhere", decision: "deny" }]);
    expect(resetRules(c).rules).toEqual([]);
  });
});

describe("config — policy overrides", () => {
  it("setCategoryPolicy toggles a known category; ignores bad input", () => {
    let c = emptyConfig();
    c = setCategoryPolicy(c, CATEGORIES.EGRESS, "allow");
    expect(c.policy[CATEGORIES.EGRESS]).toBe("allow");
    expect(setCategoryPolicy(c, "nope", "allow")).toBe(c);
    expect(setCategoryPolicy(c, CATEGORIES.MEDIA, "deny")).toBe(c); // only allow/ask
  });
  it("effectivePolicy overlays overrides on DEFAULT_POLICY", () => {
    const c = setCategoryPolicy(emptyConfig(), CATEGORIES.EGRESS, "allow");
    const eff = effectivePolicy(c);
    expect(eff[CATEGORIES.EGRESS]).toBe("allow");
    expect(eff[CATEGORIES.MEDIA]).toBe("allow"); // inherited
    expect(eff[CATEGORIES.DESTRUCTIVE]).toBe("ask"); // inherited
  });
  it("serializeConfig round-trips through parseConfig", () => {
    const c = addRecentProject(setCategoryPolicy(emptyConfig(), CATEGORIES.SHELL, "allow"), "/proj");
    expect(parseConfig(JSON.parse(serializeConfig(c)))).toEqual(c);
  });
});

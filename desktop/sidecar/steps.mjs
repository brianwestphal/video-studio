// Sidecar step registry (R-APP13, docs/desktop-app.md §5) — the pure descriptors
// that map a protocol step name onto an existing pipeline tool + how to parse its
// progress. Everything here is PURE (no fs, no spawn): `buildCommand` returns a
// logical `{ tool, args }` and `parseProgress` turns one line of the tool's output
// into a normalized progress object (or null to skip). host.mjs resolves the tool
// to an argv and does the actual spawning (the I/O edge, manual-tested).
//
// Adding a step here is how the app grows: name it, point it at a tool, and
// (optionally) give it a progress parser. The Tauri screens call steps by name.

import path from "node:path";

// Logical tool key -> repo-relative entry point. The host joins these onto the
// repo root and runs them under Node. Kept as data so it is trivially testable.
export const TOOL_PATHS = Object.freeze({
  analyzer: "dist/analyzer.js",
  "audio-events": "tools/analyze-audio-events.mjs",
  sources: "tools/analyze-sources.mjs",
});

// Resolve a logical tool key to a concrete `["node", <abs entry>]` argv prefix.
// Pure: path.join does no I/O. Throws on an unknown tool so a bad step descriptor
// fails loudly rather than spawning nothing.
export function toolArgv(tool, repoRoot) {
  const rel = TOOL_PATHS[tool];
  if (!rel) throw new Error(`unknown tool: ${tool}`);
  return ["node", path.join(repoRoot, rel)];
}

// Parse one line of `dist/analyzer.js` progress (it logs human-readable status to
// stdout — see src/analyzer.ts). Returns a normalized progress object or null.
export function parseAnalyzerProgress(line) {
  const text = String(line ?? "").trim();
  if (text === "") return null;

  let m;
  if ((m = /^Detected (\d+) scene\(s\)/.exec(text))) {
    return { stage: "detected", total: Number(m[1]), message: text };
  }
  if ((m = /^Resuming: (\d+) scene\(s\) already detected, (\d+) already described/.exec(text))) {
    return { stage: "resume", total: Number(m[1]), done: Number(m[2]), message: text };
  }
  if ((m = /^Scene (\d+)\/(\d+)\b/.exec(text))) {
    return { stage: "describe", current: Number(m[1]), total: Number(m[2]), message: text };
  }
  if (/^Detecting scene boundaries/.test(text)) {
    return { stage: "detect", message: text };
  }
  if (/^Extracting/.test(text)) {
    return { stage: "extract", message: text };
  }
  return { stage: "log", message: text };
}

// A tool with no bespoke parser: surface each non-empty line as a log-level update.
export function genericProgress(line) {
  const text = String(line ?? "").trim();
  return text === "" ? null : { stage: "log", message: text };
}

export const STEP_REGISTRY = Object.freeze({
  "analyze-scenes": {
    description: "Frame-accurate scene detection over one video (dist/analyzer.js).",
    tool: "analyzer",
    requiredParams: ["video"],
    buildCommand(params) {
      const args = [params.video];
      if (params.out) args.push("--out", params.out);
      if (params.describe) args.push("--describe", params.describe);
      if (params.model) args.push("--model", params.model);
      return { tool: "analyzer", args };
    },
    parseProgress: parseAnalyzerProgress,
  },
  "analyze-audio-events": {
    description: "Loudness/onset/section audio-event pass (tools/analyze-audio-events.mjs).",
    tool: "audio-events",
    requiredParams: ["video"],
    buildCommand(params) {
      const args = [params.video];
      if (params.out) args.push("--out", params.out);
      return { tool: "audio-events", args };
    },
    parseProgress: genericProgress,
  },
  "analyze-sources": {
    description: "Expand + analyze a pool of source files/folders (tools/analyze-sources.mjs).",
    tool: "sources",
    requiredParams: ["inputs"],
    buildCommand(params) {
      const inputs = Array.isArray(params.inputs) ? params.inputs : [params.inputs];
      const args = [...inputs];
      if (params.out) args.push("--out", params.out);
      return { tool: "sources", args };
    },
    parseProgress: genericProgress,
  },
});

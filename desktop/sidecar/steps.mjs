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
  "render-preview": "tools/render-multicam-preview.mjs",
  fcpxml: "tools/export-multicam-fcpxml.mjs",
  review: "tools/review-switches.mjs",
});

// Default port for the embedded review server (matches review-switches' default).
export const REVIEW_PORT = 8777;

// Build the argv to launch the review UI server for a project (R-RV1). Pure. The host
// spawns it long-lived with --no-open and reads the URL back (parseReviewUrl). Optional
// artifacts (audio-events/saliency) enable the re-propose feature when present.
export function reviewCommand(folder, { hasAudioEvents = false, hasSaliency = false, port = REVIEW_PORT } = {}) {
  const args = [
    path.join(folder, "multicam.json"),
    "--switches",
    path.join(folder, "switches.json"),
    "--no-open",
    "--port",
    String(port),
  ];
  if (hasAudioEvents) args.push("--audio-events", path.join(folder, "audio-events.json"));
  if (hasSaliency) args.push("--saliency", path.join(folder, "saliency.json"));
  return { tool: "review", args };
}

// Extract the server URL from review-switches' startup line ("Review UI at http://…").
// Returns the URL or null. Pure.
export function parseReviewUrl(line) {
  const m = /Review UI at (http:\/\/\S+)/.exec(String(line ?? ""));
  return m ? m[1] : null;
}

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

// The Export lane's three outcomes (R-EX1). Each reuses a shipped tool with the same
// `<multicam.json> --width --height [--switches] --out` shape. `render-preview` renders an
// mp4 (heavy, ffmpeg); `fcpxml` writes a re-cuttable FCP handoff (fast).
export const EXPORT_KINDS = Object.freeze({
  mp4: { tool: "render-preview", width: 1280, height: 720, outName: "cut.mp4" },
  social: { tool: "render-preview", width: 1080, height: 1920, outName: "cut.9x16.mp4" },
  fcpxml: { tool: "fcpxml", width: 1280, height: 720, outName: "cut.fcpxml" },
});

// Build the argv + output path for an export outcome over the current project folder.
// Pure (path.join only): the host resolves the tool, creates `exports/`, and spawns. The
// reviewed cut is included only when it exists (`hasSwitches`) — a single-angle export
// omits it. Throws on an unknown kind.
export function exportCommand(kind, folder, { hasSwitches = false } = {}) {
  const spec = EXPORT_KINDS[kind];
  if (!spec) throw new Error(`unknown export kind: ${kind}`);
  const outPath = path.join(folder, "exports", spec.outName);
  const args = [path.join(folder, "multicam.json"), "--width", String(spec.width), "--height", String(spec.height)];
  if (hasSwitches) args.push("--switches", path.join(folder, "switches.json"));
  args.push("--out", outPath);
  return { tool: spec.tool, args, outPath };
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

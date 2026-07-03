// Doctor — the sidecar's tool-presence check (R-APP16/17), the data behind the
// Setup screen. The list of tools + how a raw `which`/`--version` probe becomes a
// green/red row is PURE and unit-tested; host.mjs runs the actual `which` probes
// (the I/O edge). "Assume nothing about the machine" (R-APP1a): every tool the app
// depends on — including the Node runtime — is probed, none assumed present.

// The tools the app checks, in display order. `required` gates the stages that
// need it; optional tools (Ollama, an AI agent) are shown but never block.
// `hint` is the plain-language "how to get it" guidance the Setup screen shows.
export const DOCTOR_TOOLS = Object.freeze([
  { key: "node", label: "Node.js", required: true, hint: "https://nodejs.org (or `brew install node`)" },
  { key: "ffmpeg", label: "ffmpeg", required: true, hint: "brew install ffmpeg" },
  { key: "ffprobe", label: "ffprobe", required: true, hint: "ships with ffmpeg (brew install ffmpeg)" },
  { key: "whisper", label: "whisper", required: false, hint: "brew install openai-whisper (word-level captions)" },
  { key: "ollama", label: "Ollama", required: false, hint: "https://ollama.com (offline auto-descriptions)" },
  { key: "claude", label: "Claude", required: false, hint: "the Auto lane's default AI agent (optional)" },
]);

// Turn a map of `{ toolKey: found:boolean }` probe results into the Setup screen's
// rows + an overall readiness verdict. Pure: the caller supplies the probe results.
// A row is `{ key, label, required, found, status }` where status is
// "ok" | "missing-required" | "missing-optional". `ready` is true iff every
// required tool was found.
export function doctorResultFromChecks(found, tools = DOCTOR_TOOLS) {
  const checks = found && typeof found === "object" ? found : {};
  const rows = tools.map((t) => {
    const isFound = checks[t.key] === true;
    const status = isFound ? "ok" : t.required ? "missing-required" : "missing-optional";
    return { key: t.key, label: t.label, required: t.required, hint: t.hint, found: isFound, status };
  });
  const missingRequired = rows.filter((r) => r.status === "missing-required").map((r) => r.key);
  return { ready: missingRequired.length === 0, missingRequired, rows };
}

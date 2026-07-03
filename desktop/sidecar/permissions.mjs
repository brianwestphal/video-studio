// Application-level permission & safety layer — pure core (docs/desktop-app-permissions.md,
// VS-92). An app-owned safety checker independent of any single AI agent's own permission
// system: classify every tool call into a human-meaningful category, apply a per-category
// default policy, and honor persisted "always allow this kind" rules. Everything here is
// PURE (no fs, no I/O) and unit-tested to 100%; host.mjs / the canUseTool choke point wire
// it up, and the Permissions screen renders + persists the rules (the I/O edges).
//
// The classifier operates on ALREADY-RESOLVED absolute path strings passed in by the caller
// (the host resolves relative paths against the project root first), so this stays a pure
// function of its inputs — no cwd, no filesystem.

export const CATEGORIES = Object.freeze({
  MEDIA: "media-processing",
  READ: "read-in-project",
  WRITE: "write-in-project",
  DESTRUCTIVE: "destructive",
  EGRESS: "network-egress",
  SHELL: "other-shell",
});

// Per-category default policy (R-PERM4): allow the safe categories silently; ask on the
// rest. Tuned so the Auto lane rarely prompts for normal work.
export const DEFAULT_POLICY = Object.freeze({
  [CATEGORIES.MEDIA]: "allow",
  [CATEGORIES.READ]: "allow",
  [CATEGORIES.WRITE]: "allow",
  [CATEGORIES.DESTRUCTIVE]: "ask",
  [CATEGORIES.EGRESS]: "ask",
  [CATEGORIES.SHELL]: "ask",
});

// Our own pipeline + engine tools (media processing). Matched against a Bash command's
// first token or a tool name.
const MEDIA_COMMANDS = ["ffmpeg", "ffprobe", "whisper", "ollama"];
const MEDIA_TOOL_NAMES = ["analyze-scenes", "analyze-audio-events", "analyze-sources", "propose-switches"];
const READ_TOOLS = ["Read", "Grep", "Glob", "LS"];
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];
const EGRESS_TOOLS = ["WebFetch", "WebSearch"];
const QUESTION_TOOLS = ["AskUserQuestion"];

// Pure POSIX-style path normalization (macOS): collapse `.`/`..` segments WITHOUT touching
// the filesystem or cwd. Inputs are expected absolute; a result that still starts with `..`
// has escaped its base.
function normalizePath(p) {
  const s = String(p);
  const abs = s.startsWith("/");
  const out = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      // for an absolute path, `..` above root is a no-op
    } else {
      out.push(seg);
    }
  }
  return (abs ? "/" : "") + out.join("/");
}

// Is an absolute path inside the project root? Pure string containment after normalization,
// so `../` traversal that escapes the root reads as outside (R-PERM3).
export function isInProject(absPath, projectRoot) {
  if (!absPath || !projectRoot) return false;
  const p = normalizePath(absPath);
  const root = normalizePath(projectRoot);
  return p === root || p.startsWith(root + "/");
}

// Destructive shell patterns: deletion, or output redirection / move that could clobber.
const DESTRUCTIVE_CMD_RE = /(^|[;&|]\s*)(rm|rmdir|unlink|shred)\b|>\s*\/|\bmv\b|\bdd\b/;
const EGRESS_CMD_RE = /(^|[;&|]\s*)(curl|wget|nc|ncat|ssh|scp|rsync|git\s+push|npm\s+publish)\b/;

function classifyBash(command, projectRoot) {
  const cmd = String(command ?? "").trim();
  const first = cmd.split(/\s+/)[0];
  const base = first.split("/").pop();
  if (DESTRUCTIVE_CMD_RE.test(cmd)) return CATEGORIES.DESTRUCTIVE;
  if (EGRESS_CMD_RE.test(cmd)) return CATEGORIES.EGRESS;
  if (MEDIA_COMMANDS.includes(base)) return CATEGORIES.MEDIA;
  // `node <repo>/dist/analyzer.js` or a tools/*.mjs invocation = our pipeline.
  if (base === "node" && /(dist\/analyzer\.js|tools\/[\w-]+\.mjs)/.test(cmd)) return CATEGORIES.MEDIA;
  void projectRoot;
  return CATEGORIES.SHELL;
}

// Classify a tool call into one human-meaningful category (R-PERM1). Conservative: an
// unrecognized/ambiguous call falls to the most restrictive plausible category, never
// silently to an allowed one (R-PERM3). `input` is the tool's argument object; paths in it
// are expected pre-resolved to absolute.
export function classifyToolCall(toolName, input, projectRoot) {
  const name = String(toolName ?? "");
  const args = input && typeof input === "object" ? input : {};

  if (MEDIA_TOOL_NAMES.includes(name)) return CATEGORIES.MEDIA;
  if (EGRESS_TOOLS.includes(name)) return CATEGORIES.EGRESS;

  if (name === "Bash") return classifyBash(args.command, projectRoot);

  if (READ_TOOLS.includes(name)) {
    const p = args.file_path ?? args.path;
    return isInProject(p, projectRoot) ? CATEGORIES.READ : CATEGORIES.SHELL;
  }
  if (WRITE_TOOLS.includes(name)) {
    const p = args.file_path ?? args.notebook_path ?? args.path;
    return isInProject(p, projectRoot) ? CATEGORIES.WRITE : CATEGORIES.DESTRUCTIVE;
  }
  // Anything unrecognized (and not a question — those are handled by decide) → ask.
  return CATEGORIES.SHELL;
}

// Match a call's category against the persisted rule set (R-PERM6). A rule is
// `{ category, scope: "project"|"everywhere", project?, decision: "allow"|"deny" }`.
// Precedence: a project-scoped rule beats an everywhere rule; within the same specificity
// an explicit `deny` beats an `allow`. Returns "allow" | "deny" | null (no match). Pure.
export function matchRule(category, projectRoot, rules) {
  const list = Array.isArray(rules) ? rules : [];
  const matches = list.filter((r) => {
    if (!r || r.category !== category) return false;
    if (r.scope === "everywhere") return true;
    return r.scope === "project" && r.project === projectRoot;
  });
  if (matches.length === 0) return null;
  const projectScoped = matches.filter((r) => r.scope === "project");
  const tier = projectScoped.length > 0 ? projectScoped : matches;
  return tier.some((r) => r.decision === "deny") ? "deny" : "allow";
}

// The full decision at the choke point (R-PERM7): questions are never gated (R-PERM9);
// otherwise apply persisted rules first, and only fall back to the category default on a
// miss — returning "allow" | "deny" | "ask". Pure over (toolName, input, projectRoot, rules).
export function decide(toolName, input, projectRoot, rules) {
  if (QUESTION_TOOLS.includes(String(toolName ?? ""))) return "allow";
  const category = classifyToolCall(toolName, input, projectRoot);
  const ruled = matchRule(category, projectRoot, rules);
  if (ruled !== null) return ruled;
  return DEFAULT_POLICY[category] === "allow" ? "allow" : "ask";
}

// The tool names to pre-approve via the backend's allow-list (R-PERM8), DERIVED from the
// allow-by-default categories so the allow-list can't drift from the policy. Pure.
export function deriveAllowedTools(policy = DEFAULT_POLICY) {
  const allowed = [];
  if (policy[CATEGORIES.MEDIA] === "allow") allowed.push(...MEDIA_TOOL_NAMES);
  if (policy[CATEGORIES.READ] === "allow") allowed.push(...READ_TOOLS);
  if (policy[CATEGORIES.WRITE] === "allow") allowed.push(...WRITE_TOOLS);
  return allowed;
}

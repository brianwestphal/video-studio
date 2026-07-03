// App-global config store — pure core (R-APP18 + R-PERM12). One per-user config the app
// owns (recent projects, the selected agent backend, permission policy overrides + the
// remembered "always allow this kind" rules), stored separately from any project folder and
// from any agent's own settings. Everything here is PURE (no fs): host.mjs reads/writes the
// JSON file under the app's Application Support dir (the I/O edge); these functions are the
// tolerant parse + the immutable transforms, unit-tested to 100%.

import { CATEGORIES, DEFAULT_POLICY } from "./permissions.mjs";

export const CONFIG_VERSION = 1;
export const DEFAULT_RECENT_LIMIT = 10;
const SCOPES = new Set(["project", "everywhere"]);
const CATEGORY_SET = new Set(Object.values(CATEGORIES));

// A fresh, empty config. Pure.
export function emptyConfig() {
  return { version: CONFIG_VERSION, recentProjects: [], agentBackend: "claude", policy: {}, rules: [] };
}

// Keep only well-formed rules: a known category, a valid scope (with a project path when
// project-scoped), and an allow/deny decision.
function sanitizeRules(rules) {
  if (!Array.isArray(rules)) return [];
  const clean = [];
  for (const r of rules) {
    if (!r || typeof r !== "object") continue;
    if (!CATEGORY_SET.has(r.category)) continue;
    if (!SCOPES.has(r.scope)) continue;
    if (r.scope === "project" && (typeof r.project !== "string" || r.project === "")) continue;
    if (r.decision !== "allow" && r.decision !== "deny") continue;
    const rule = { category: r.category, scope: r.scope, decision: r.decision };
    if (r.scope === "project") rule.project = r.project;
    clean.push(rule);
  }
  return clean;
}

// Keep only category → allow/ask policy overrides for known categories.
function sanitizePolicy(policy) {
  const out = {};
  if (policy && typeof policy === "object") {
    for (const [k, v] of Object.entries(policy)) {
      if (CATEGORY_SET.has(k) && (v === "allow" || v === "ask")) out[k] = v;
    }
  }
  return out;
}

// Parse a raw (already JSON-parsed) config into a normalized shape, tolerating missing /
// corrupt fields by falling back to defaults (R-APP18: a bad config never crashes the app).
export function parseConfig(raw) {
  const base = emptyConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  return {
    version: CONFIG_VERSION,
    recentProjects: Array.isArray(raw.recentProjects)
      ? raw.recentProjects.filter((p) => typeof p === "string" && p !== "")
      : [],
    agentBackend: typeof raw.agentBackend === "string" && raw.agentBackend !== "" ? raw.agentBackend : "claude",
    policy: sanitizePolicy(raw.policy),
    rules: sanitizeRules(raw.rules),
  };
}

// Move `folder` to the front of the recent list (deduped), capped at `limit`. Pure —
// returns a new config (R-APP9 recent projects).
export function addRecentProject(config, folder, limit = DEFAULT_RECENT_LIMIT) {
  if (typeof folder !== "string" || folder === "") return config;
  const rest = config.recentProjects.filter((p) => p !== folder);
  return { ...config, recentProjects: [folder, ...rest].slice(0, Math.max(0, limit)) };
}

// Add a remembered "always allow/deny this kind" rule (R-PERM5), sanitized + deduped.
// Returns a new config; an invalid rule is a no-op.
export function addRule(config, rule) {
  const [clean] = sanitizeRules([rule]);
  if (!clean) return config;
  const exists = config.rules.some(
    (r) => r.category === clean.category && r.scope === clean.scope && r.project === clean.project,
  );
  if (exists) {
    // Replace the existing rule's decision (an explicit new choice wins).
    return {
      ...config,
      rules: config.rules.map((r) =>
        r.category === clean.category && r.scope === clean.scope && r.project === clean.project ? clean : r,
      ),
    };
  }
  return { ...config, rules: [...config.rules, clean] };
}

// Remove the rule at `index` (per-rule revoke, R-PERM11). Out-of-range = no-op. Pure.
export function revokeRule(config, index) {
  if (!Number.isInteger(index) || index < 0 || index >= config.rules.length) return config;
  return { ...config, rules: config.rules.filter((_, i) => i !== index) };
}

// Clear every remembered rule (reset-all, R-PERM11). Pure.
export function resetRules(config) {
  return { ...config, rules: [] };
}

// Toggle a category's default policy (the Permissions screen plain-language toggles,
// R-PERM10). `decision` must be "allow" or "ask"; anything else is a no-op. Pure.
export function setCategoryPolicy(config, category, decision) {
  if (!CATEGORY_SET.has(category) || (decision !== "allow" && decision !== "ask")) return config;
  return { ...config, policy: { ...config.policy, [category]: decision } };
}

// The effective per-category policy: the built-in DEFAULT_POLICY with the user's overrides
// applied on top. Feeds decide()/deriveAllowedTools(). Pure.
export function effectivePolicy(config) {
  return { ...DEFAULT_POLICY, ...config.policy };
}

// Stable pretty JSON for writing to disk. Pure.
export function serializeConfig(config) {
  return JSON.stringify(config, null, 2);
}

# Desktop app — application-level permission & safety layer (VS-85)

An **app-owned safety checker, independent of any single AI agent's own permission
system**, so that even a prompt-injection or a model mistake is gated by *our* policy —
defense in depth. It lives at the **agent backend's tool-permission choke point** (Claude's
`canUseTool`; the equivalent gate for the Codex / Ollama backends, per
[`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md)), plus the backend's
pre-approval allow-list, and optionally a `PreToolUse`-style hook as a second enforcement
point. Because it sits **above the pluggable agent abstraction**, one policy covers every
backend. Its defining feature is first-class **"always allow this kind"**: approvals accrue
as category rules, so a non-technical user faces near-zero friction for routine work while
genuinely risky actions still surface.

Part of the desktop-app initiative — see the umbrella [`desktop-app.md`](desktop-app.md)
(VS-80) and the [pluggable AI agent control bridge](desktop-app-agent-bridge.md) (VS-83,
which routes non-pre-approved calls into the choke point this layer implements).
Design rationale: [`investigations/ui-app.md`](investigations/ui-app.md) §10.

Status: **Design only** — nothing built yet. Depends on VS-83 (the agent bridge's choke
point). Wireframe screen 07.

## 1. Principle

**The model proposes, the app decides.** We do not rely solely on the AI agent's own
permission system; the app classifies every tool call by *what it does to the user's
stuff*, applies
its own per-category policy, and remembers the user's "always allow" choices as
category/pattern rules (not exact strings), stored in the app's own config.

## 2. Classify every tool call into a human-meaningful category

- **R-PERM1** Every tool call is classified into exactly one **human-meaningful category**
  from `{ media-processing, read-in-project, write-in-project, destructive, network-egress,
  other-shell }`, derived from the **tool name + input** (e.g. the command + its paths), not
  a raw command string shown to the user:
  - **media-processing** — our ffmpeg / whisper / ollama + pipeline tools.
  - **read-in-project** — reads confined to the current project folder.
  - **write-in-project** — writes results into the current project folder.
  - **destructive** — `rm`, overwriting a *source* file, or any write **outside** the
    project folder.
  - **network-egress** — anything beyond localhost Ollama + the Anthropic API.
  - **other-shell** — shell that doesn't match the above.
- **R-PERM2** The classifier is a **pure function** of `(toolName, input, projectRoot)` with
  **no I/O**, and is **unit-tested to 100%** (lines/branches/functions/statements — project
  convention). Path-containment checks (in-project vs outside) operate on normalized/resolved
  path strings passed in, so the pure core stays side-effect-free.
- **R-PERM3** Classification is **conservative**: an unrecognized or ambiguous call falls
  through to the most restrictive plausible category (`other-shell` / `destructive`), never
  silently to an allowed one. Path traversal / symlink-escape attempts resolve to
  `destructive` (outside-project).

## 3. Per-category default policy

- **R-PERM4** Each category has a **default policy** of `allow` or `ask`, tuned so the Auto
  lane rarely prompts for normal work: **media-processing, read-in-project, write-in-project
  → allow silently**; **destructive, network-egress, other-shell → ask** (deny on an
  explicit reject). Defaults are pure data + a pure lookup (unit-tested).

## 4. Rule matching + "always allow this kind"

- **R-PERM5** Every permission prompt offers **Allow once / Deny / Always allow this
  category**. Choosing *Always* **persists a category rule** remembered across runs, so
  approvals accrue and the user is asked less over time. Rules are **category/pattern-based,
  not exact-string** — "always allow media-processing" covers every future ffmpeg call.
- **R-PERM6** A persisted rule may be **scoped**: `this project` vs `everywhere`. Matching a
  call against the stored rule set — category + scope + current project — is a **pure
  function** (`(call, projectRoot, rules) → allow | deny | ask`) and unit-tested to 100%,
  including precedence when multiple rules could match (most-specific / project-scoped wins;
  an explicit deny beats an allow).
- **R-PERM7** Enforcement order at the **agent backend's choke point** (R-CB9): **(1)** apply
  persisted rules; **(2)** on a rule match return allow/deny **without prompting**; **(3)**
  only on a *miss* fall back to the category default (R-PERM4) — prompt if it's `ask`,
  otherwise apply the default. The prompt's *Always* choice writes a new rule (R-PERM5) that
  will short-circuit future matches. This runs identically regardless of which backend
  (Claude / Codex / Ollama) is active.

## 5. Map down to the backend

- **R-PERM8** The always-safe categories are **pre-approved via the backend's allow-list**
  (Claude's `allowedTools`; the equivalent for other backends) so they never hit the choke
  point; everything else flows through it, where this layer runs R-PERM7. Because
  pre-approved tools bypass the choke point (R-CB9 caveat), the allow-list is derived from
  the *allow-by-default* categories and kept in sync with the policy — it is not a separate,
  hand-maintained trust list that could drift.
- **R-PERM9** A backend's **question** affordance (Claude's `AskUserQuestion`, routed through
  the same choke point, R-CB10) is handled by the question UI, not gated as a risky tool —
  answering a question is not a filesystem/network action.

## 6. Permissions screen (user-visible + resettable)

- **R-PERM10** A **Permissions screen** presents a few **plain-language toggles** — "Let
  video-studio: process video · read this project · write results here · run other commands
  (ask)" — that map onto the category default policy (R-PERM4).
- **R-PERM11** The screen shows a **live list of remembered approvals** (the persisted
  rules, R-PERM5/6) with **per-rule revoke** and a **reset-all**. Revoking a rule takes
  effect immediately for subsequent calls.
- **R-PERM12** Rules + toggles are stored in the **app's own config** (per-project and/or
  global, per R-APP18), **not** buried in any agent's own settings. Loading/merging/saving
  the rule store is pure over its parsed contents (the file read/write is the thin I/O edge).

## 7. Cross-references

- [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md) — the backend tool-permission
  choke point (R-CB9) + question routing (R-CB10) this layer implements (VS-83).
- [`desktop-app.md`](desktop-app.md) — the app-global config location (R-APP18) the rule
  store lives in (VS-80).
- [`investigations/ui-app.md`](investigations/ui-app.md) §10 — the safety-layer rationale +
  the category set / default policy this doc pins down.

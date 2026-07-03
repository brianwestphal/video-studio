# Desktop app — application-level permission & safety layer (VS-85)

An **app-owned safety checker, independent of Claude Code's own permission system**, so
that even a prompt-injection or a model mistake is gated by *our* policy — defense in
depth. It lives at the SDK **`canUseTool`** choke point (plus `allowedTools` pre-approval,
and optionally a `PreToolUse` hook as a second enforcement point). Its defining feature is
first-class **"always allow this kind"**: approvals accrue as category rules, so a
non-technical user faces near-zero friction for routine work while genuinely risky actions
still surface.

Part of the desktop-app initiative — see the umbrella [`desktop-app.md`](desktop-app.md)
(VS-80) and the [Claude Agent SDK control bridge](desktop-app-claude-bridge.md) (VS-83,
which routes non-pre-approved calls into the `canUseTool` callback this layer implements).
Design rationale: [`investigations/ui-app.md`](investigations/ui-app.md) §10.

Status: **Design only** — nothing built yet. Depends on VS-83 (the `canUseTool` bridge).
Wireframe screen 07.

## 1. Principle

**The model proposes, the app decides.** We do not rely solely on Claude Code's permission
system; the app classifies every tool call by *what it does to the user's stuff*, applies
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
- **R-PERM7** Enforcement order at the `canUseTool` choke point: **(1)** apply persisted
  rules; **(2)** on a rule match return allow/deny **without prompting**; **(3)** only on a
  *miss* fall back to the category default (R-PERM4) — prompt if it's `ask`, otherwise apply
  the default. The prompt's *Always* choice writes a new rule (R-PERM5) that will short-
  circuit future matches.

## 5. Map down to the SDK

- **R-PERM8** The always-safe categories are **pre-approved via `allowedTools`** so they
  never hit the callback; everything else flows through **`canUseTool`**, where this layer
  runs R-PERM7. Because pre-approved tools bypass the callback (R-CB7 caveat), the
  `allowedTools` set is derived from the *allow-by-default* categories and kept in sync with
  the policy — it is not a separate, hand-maintained trust list that could drift.
- **R-PERM9** `AskUserQuestion` (routed through the same callback, R-CB8) is handled by the
  question UI, not gated as a risky tool — answering a question is not a filesystem/network
  action.

## 6. Permissions screen (user-visible + resettable)

- **R-PERM10** A **Permissions screen** presents a few **plain-language toggles** — "Let
  video-studio: process video · read this project · write results here · run other commands
  (ask)" — that map onto the category default policy (R-PERM4).
- **R-PERM11** The screen shows a **live list of remembered approvals** (the persisted
  rules, R-PERM5/6) with **per-rule revoke** and a **reset-all**. Revoking a rule takes
  effect immediately for subsequent calls.
- **R-PERM12** Rules + toggles are stored in the **app's own config** (per-project and/or
  global, per R-APP18), **not** buried in Claude Code's settings. Loading/merging/saving the
  rule store is pure over its parsed contents (the file read/write is the thin I/O edge).

## 7. Cross-references

- [`desktop-app-claude-bridge.md`](desktop-app-claude-bridge.md) — the `canUseTool` callback
  (R-CB7) + `AskUserQuestion` routing (R-CB8) this layer implements (VS-83).
- [`desktop-app.md`](desktop-app.md) — the app-global config location (R-APP18) the rule
  store lives in (VS-80).
- [`investigations/ui-app.md`](investigations/ui-app.md) §10 — the safety-layer rationale +
  the category set / default policy this doc pins down.

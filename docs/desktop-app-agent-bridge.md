# Desktop app — AI agent control bridge (pluggable: Claude / Codex / Ollama) (VS-83)

The **Auto lane's engine.** The app designs cuts by driving an **AI coding agent**
headlessly from the Node sidecar host and consuming its **structured event stream** — not
by scraping an interactive TUI. The agent backend is **pluggable**: the app targets
**Claude** (via `@anthropic-ai/claude-agent-sdk`), **Codex**, and **Ollama** (local
models) behind one common interface, so the Auto lane is not tied to any single provider.
Claude is the **first / reference backend** (initial testing is Claude-only); Codex and
Ollama land behind the same interface as follow-ups.

Because the agent is **optional** (maintainer decision, 2026-07-03), the Manual lane
([`desktop-app.md`](desktop-app.md) + the Review stage, VS-87) works with **no agent at
all** — the bridge powers Auto, not the whole app.

Part of the desktop-app initiative — see the umbrella [`desktop-app.md`](desktop-app.md)
(shell + sidecar host, VS-80) and the safety layer
[`desktop-app-permissions.md`](desktop-app-permissions.md) (VS-85, which enforces at the
backend's tool-permission choke point defined here). Design rationale:
[`investigations/ui-app.md`](investigations/ui-app.md) §9.

Status: **Live (Claude)** — the pure core (`desktop/sidecar/agent.mjs`, 100% unit) **and** the
live Claude backend are built: the `agent-run` host step drives `@anthropic-ai/claude-agent-sdk`
headless, streams its events through `normalizeClaudeEvent`/`eventToFeedEntry` (R-CB2/3/6), captures
the `session_id`, and gates every escalated tool call through `permissions.decide` at the
`canUseTool` choke point (R-CB9) — verified against a real run. The Design **Auto lane** calls it
with a live activity feed. **Remaining (follow-ups):** the Auto lane landing on a finished structured
cut plan + session-resume UX (**VS-96**); interactive native permission prompts / `AskUserQuestion`
picker / `allowedTools` pre-approval / the SDK-own-sandbox coverage gap (**VS-97**); Keychain auth
(**VS-84**); and the **Codex/Ollama** backends (R-CB4/5, VS-93/94). Note: the SDK ships as a
**devDependency** (desktop-only; excluded from the lean published npm package — packaging is VS-89).

## 1. Why structured events, not TUI scraping

Scraping an interactive agent TUI for control flow (login state, permission prompts,
questions) means parsing terminal output that changes across versions — fragile. Every
backend we target can instead be run in a **headless / programmatic mode** that yields
**typed events** and (for the agentic ones) a **tool-permission callback**. That callback
is what makes a native approve/deny + question UI possible; it is also the choke point the
app-owned permission layer (VS-85) enforces at. Interactive login stays a terminal/browser
flow (VS-84) — the one thing headless can't do.

## 2. Pluggable agent-backend abstraction

- **R-CB1** The Auto lane runs against a **pluggable agent-backend interface** with a small
  common contract: *run a task* (intent text + project context) → *stream normalized
  structured events* (see R-CB6), expose a *tool-permission choke point* (R-CB9), and
  *report capabilities* (does it support native sessions/resume? native tool-use? a
  permission callback?). The app ships **Claude, Codex, and Ollama** backends behind this
  interface; the active backend is **user-selectable** in settings. **Claude is the first +
  reference backend** — initial development and testing target Claude only, with Codex and
  Ollama added behind the same interface (their own build tickets).
- **R-CB2** The permission layer (VS-85) and the activity-feed UI sit **above** the
  abstraction and are **backend-agnostic** — they consume normalized events (R-CB6) and the
  common choke point (R-CB9), never provider-specific event shapes. Backends **degrade
  gracefully by capability**: a feature a backend lacks (e.g. native sessions) is emulated
  or disabled, never faked.

## 3. Claude backend (first / reference)

- **R-CB3** The Claude backend runs Claude Code **headless via the Agent SDK**
  (`@anthropic-ai/claude-agent-sdk`) inside the sidecar host (R-APP11) — **not** by
  scraping the TUI and **not** via the bare headless CLI (the bare CLI has no `canUseTool`
  callback, which is the whole reason to prefer the SDK). Its **SDK/CLI version is pinned**
  and the event consumer **tolerates unknown event types** (the schema evolves) — an
  unrecognized event is logged/ignored, never fatal.

## 4. Additional backends

- **R-CB4** **Codex backend** *(built — VS-93)* — drive OpenAI's Codex agent headless via
  `codex exec --json` behind the same interface (R-CB1): `normalizeCodexEvent` maps its JSONL
  stream to the shared event shape (R-CB6), and its permission mechanism is the **sandbox
  mode** — we run `-s read-only` as the choke point (R-CB9), coarser than Claude's per-call
  callback: Codex may read the project to design the cut but never writes/executes, so OUR host
  lands the plan from Codex's `--output-schema` final message. Auth is its own ChatGPT/Codex
  credential path (R-CB11). Pure core `desktop/sidecar/codex-backend.mjs` (100% unit); I/O is
  `runCodexAgent` in host.mjs. Verified live (manual-test §15.20). Session resume
  (`codex exec resume <thread_id>`) + the backend-selector UI are follow-ups.
- **R-CB5** **Ollama backend** *(built — VS-94)* — drive a **local model** via Ollama behind
  the same interface. Local chat models generally lack a full agentic tool-use SDK, so this
  backend runs an **app-driven constrained tool loop**: the app offers the pipeline tools
  (`read_file`, `propose_baseline`), parses the model's tool requests, and routes each through
  the **same permission choke point** (R-CB9, `decide()`) before executing — so the safety
  layer (VS-85) applies identically. Capability flags (R-CB1, `OLLAMA_CAPABILITIES`) advertise
  its reduced feature set (no native session; structured-output model-dependent). Ollama is
  **local — no auth** (R-CB11). The pure loop core is `desktop/sidecar/ollama-backend.mjs`
  (100% unit); the I/O loop is `runOllamaAgent` in host.mjs, dispatched on `config.agentBackend`.
  Verified live against `gemma4:12b` (manual-test §15.19). The in-app backend-selector UI is a
  follow-up.

## 5. Driving a run + structured events → UI

- **R-CB6** A Claude/agent run is triggered from the **Design/Auto lane** (VS-86) with the
  user's intent (e.g. *"a punchy 15-second teaser"*) plus the current project's artifacts as
  context; it is a **pipeline step** on the sidecar protocol (R-APP12) like analyze/export.
  The backend's raw events are **normalized to a common event shape** — task start (with a
  session handle where supported), assistant/progress text, tool-use, tool-result, and a
  terminal result — and streamed to the UI as protocol progress events. The webview renders
  a friendly **activity feed** ("Analyzing scenes ✓", "Proposed a 15 s teaser", generated
  files). The **event→feed mapping is a pure function** (normalized event → feed entry) and
  unit-tested to 100%.
- **R-CB7** Since we own the prompt, the bridge **prefers a JSON-schema structured result**
  — a **cut plan** (a `switches.json`/cut-spec-shaped object) the app renders and hands to
  Review — over parsing prose out of assistant text. Validating the structured result
  against its schema is pure and unit-tested (`validateCutPlan`); turning a validated plan
  into a **writable `switches.json` document** (adding `version` + the project's `groupId`,
  optional `rationale`) is the pure `cutPlanToSwitches` — the Auto-lane → Review bridge, so
  the agent's result becomes the *same* artifact the Manual lane produces. An invalid/missing
  result degrades gracefully (surface the run's text + let the user open Review on whatever
  artifacts were written). Backends whose structured-output support is weaker (R-CB5) fall
  back to this path. *(Driving the live agent to emit the plan + writing the file is the I/O
  tail — VS-96.)*

## 6. Session lifecycle

- **R-CB8** Where the backend supports it, the bridge **captures a session handle** (Claude's
  `session_id` from `system`/`init`) and supports **resume** so the user can refine over
  multiple turns ("make it 5 seconds shorter", "favor the guitar") without losing context.
  Session state is scoped to the project and does not leak between projects. Backends without
  native sessions (per R-CB1 capabilities) emulate continuity by replaying prior context or
  disable resume — never silently drop it.

## 7. Constraining the tool surface + permission choke point

- **R-CB9** Our own pipeline tools are **pre-approved** (Claude: `allowedTools` / an
  app-provided MCP server; other backends: the equivalent allow-list) so normal Auto-lane
  work does not prompt. Any tool call **not** pre-approved is routed through the backend's
  **tool-permission choke point** (Claude's `canUseTool(toolName, input)` callback; the
  Ollama loop's pre-execute gate, R-CB5), which delegates to the application-level permission
  layer (VS-85, [`desktop-app-permissions.md`](desktop-app-permissions.md)) and returns
  allow/deny. **Caveat:** pre-approved tools bypass the choke point, so the allow-list is
  itself a trust decision the permission layer's default policy owns.
- **R-CB10** A backend's **question** affordance (Claude's `AskUserQuestion`, arriving
  through the same callback with a `questions[]` + `options` payload) is surfaced as a
  **native picker** and the answer fed back — "the agent is asking something" becomes a
  friendly dialog, not terminal text.

## 8. Auth / credential handling

- **R-CB11** A run that fails for **lack of credentials** is **detected from the backend's
  result/error** (not scraped) and surfaced as a distinct "not connected" state that
  triggers the backend-appropriate **Connect** flow (VS-84) — Claude: OAuth login /
  `setup-token` / API key; Codex: its own credential; **Ollama: local, no auth**. A generic
  run failure (not credential-related) stays a retryable error, distinct from "not
  connected."

## 9. Cross-references

- [`desktop-app.md`](desktop-app.md) — the sidecar host + protocol the bridge is a step on,
  and the settled decision that the agent is optional + pluggable (VS-80).
- [`desktop-app-permissions.md`](desktop-app-permissions.md) — the policy behind the
  backend-agnostic permission choke point (VS-85).
- VS-84 — Connect / auth (the trigger in R-CB11), per backend.
- VS-86 — the Design/Auto lane that invokes this bridge.
- [`investigations/ui-app.md`](investigations/ui-app.md) §9 — control-channel rationale + the
  decisions this raises (SDK vs CLI, auth model, how agentic, version-pinning).

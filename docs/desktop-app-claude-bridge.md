# Desktop app — Claude Agent SDK control bridge (VS-83)

The **Auto lane's engine.** The app drives Claude Code to design cuts by running it
**headlessly through the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) from the
same Node sidecar host the Rust shell already spawns — **not** by scraping the interactive
TUI. The SDK yields structured, streamed events, so there is nothing to parse out of
ANSI/redraw output, and it exposes the `canUseTool` callback that makes a native
approve/deny + question UI possible.

Part of the desktop-app initiative — see the umbrella
[`desktop-app.md`](desktop-app.md) (shell + sidecar host, VS-80) and the safety layer
[`desktop-app-permissions.md`](desktop-app-permissions.md) (VS-85, which consumes the
`canUseTool` choke point defined here). Design rationale:
[`investigations/ui-app.md`](investigations/ui-app.md) §9.

Status: **Design only** — nothing built yet. Depends on VS-80 (sidecar host); pairs with
the auth flow (VS-84) and the permission layer (VS-85).

## 1. Why the SDK, not TUI scraping

Scraping the interactive `claude` TUI for control flow (login state, permission prompts,
questions) means parsing terminal output that changes across Claude Code versions — fragile.
The Agent SDK is purpose-built: it streams **typed events** and invokes a **callback** for
tool permission and questions. The one thing the SDK can't do is interactive login — that
stays a terminal/browser flow (VS-84).

## 2. Running Claude

- **R-CB1** The app runs Claude Code **headless via the Agent SDK**
  (`@anthropic-ai/claude-agent-sdk`) inside the Node sidecar host (R-APP11), **never** by
  scraping the interactive TUI and never via the bare headless CLI (the bare CLI has no
  `canUseTool` callback — R-CB7 — which is the whole reason to prefer the SDK).
- **R-CB2** The **SDK/CLI version is pinned**, and the event consumer **tolerates unknown
  event types** (the event schema evolves) — an unrecognized event is logged/ignored, never
  fatal.
- **R-CB3** A Claude run is triggered from the **Design/Auto lane** (VS-86) with the user's
  intent (e.g. *"a punchy 15-second teaser"*) plus the current project's artifacts as
  context; it is a **pipeline step** on the sidecar protocol (R-APP12) like any other, so
  the UI drives it the same way it drives analyze/export.

## 3. Structured events → UI

- **R-CB4** The bridge **streams the SDK's structured events** — `system`/`init` (carrying
  `session_id`), `assistant` messages, `tool_use`, `tool_result`, and the terminal `result`
  — to the UI as sidecar-protocol progress events (R-APP12). The webview renders a friendly
  **activity feed** ("Analyzing scenes ✓", "Proposed a 15 s teaser", the generated files),
  mapping raw events to human-meaningful lines. The **event→feed mapping is a pure
  function** (event object → feed entry) and unit-tested to 100%.
- **R-CB5** Since we own the prompt/skill, the bridge **prefers a JSON-schema structured
  result** — a **cut plan** (e.g. a `switches.json`/cut-spec-shaped object) the app renders
  and hands to Review — over parsing prose out of `assistant` text. Validating the
  structured result against its schema is pure and unit-tested; an invalid/missing
  structured result degrades gracefully (surface the run's text + let the user open Review
  on whatever artifacts were written).

## 4. Session lifecycle

- **R-CB6** The bridge **captures `session_id`** from the `system`/`init` event and
  supports **resume** so the user can refine over multiple turns ("make it 5 seconds
  shorter", "favor the guitar") without losing context. Session state is scoped to the
  project and does not leak between projects.

## 5. Constraining the tool surface

- **R-CB7** Our own pipeline tools are **pre-approved via `allowedTools`** (or exposed as
  an **app-provided MCP server**) so normal Auto-lane work does not prompt the user. Any
  tool call **not** pre-approved is routed through the SDK's **`canUseTool(toolName, input)`
  callback**, which delegates to the application-level permission layer (VS-85,
  [`desktop-app-permissions.md`](desktop-app-permissions.md)) and returns
  `{behavior:"allow"}` / `{behavior:"deny"}`. **Caveat:** pre-approved tools never reach
  the callback, so `allowedTools` is itself a trust decision the permission layer's default
  policy must own.
- **R-CB8** The **`AskUserQuestion`** tool arrives through the **same `canUseTool`
  callback** (with a `questions[]` + `options` payload); the app renders it as a **native
  picker** and feeds the answer back — "Claude is asking something" becomes a friendly
  dialog, not terminal text.

## 6. Auth failure handling

- **R-CB9** A headless run that fails for **lack of credentials** (auth error / non-zero
  exit) is **detected from the SDK result/error** (not scraped) and surfaced as a distinct
  "not connected" state that triggers the **Connect Claude** flow (VS-84) — as opposed to a
  generic run failure, which the screen can retry.

## 7. Cross-references

- [`desktop-app.md`](desktop-app.md) — the sidecar host + protocol this bridge is a step on
  (VS-80).
- [`desktop-app-permissions.md`](desktop-app-permissions.md) — the policy behind
  `canUseTool` (VS-85).
- VS-84 — Connect Claude / auth (the trigger in R-CB9).
- VS-86 — the Design/Auto lane that invokes this bridge.
- [`investigations/ui-app.md`](investigations/ui-app.md) §9 — control-channel rationale +
  the decisions this raises (SDK vs CLI, auth model, how agentic, version-pinning).

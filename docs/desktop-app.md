# Desktop app — guided visual workspace over the existing pipeline (VS-76)

The desktop app is a **native shell around the existing CLI pipeline**, not a rewrite.
It gives non-technical creatives (musicians, videographers) a timeline-and-buttons front
door to the same engine the Claude skill drives today. This document is the umbrella
requirements doc for the app's **shell, project model, stage navigation, and the Node
sidecar host** (VS-80); the two subsystems with their own specs are the
[pluggable AI agent control bridge](desktop-app-agent-bridge.md) (VS-83) and the
[application-level permission & safety layer](desktop-app-permissions.md) (VS-85).

Design background + the phased roadmap live in
[`investigations/ui-app.md`](investigations/ui-app.md); the seven-screen visual deck is
[`investigations/ui-app-wireframe.html`](investigations/ui-app-wireframe.html) (VS-78).

Status: **Design only** — nothing here is built yet. Requirements are captured so the
build (VS-79 spike → VS-80 shell → the screen tickets) has a source of truth.

## 1. Concept

A **guided project workspace** that walks a creative from *"drop in footage"* to
*"finished cut"* without a terminal, while keeping the power users' escape hatches. The
unit of work is a **Project** (a folder of footage). A left rail of pipeline stages —
**Setup → New Project → Analyze → Design → Review/Edit → Export** — each a visual panel
with live progress. The engine underneath is the unchanged `tools/*.mjs` + `dist/analyzer.js`
pipeline; the app only *invokes* those and *visualizes* their JSON artifacts.

The app has **two lanes into the same engine**: an **Auto lane** (describe intent → an AI
agent proposes a cut) and a **Manual lane** (the timeline/review editor). The AI agent is
**optional and pluggable** — Claude, Codex, or a local Ollama model behind one interface
(see [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md)) — so the Manual lane
works with no agent at all. **Both lanes ship in the MVP** (maintainer decision,
2026-07-03).

## 2. Architecture

- **R-APP1** The app is a **Tauri** shell (Rust window) with a **vanilla HTML/JS/TS
  webview frontend** — no React/Svelte — matching the maintainer's existing
  `~/Documents/hotsheet` + `~/Documents/glassbox` pattern. The heavy engine (ffmpeg /
  whisper / ollama / an AI agent) stays **external** to the webview.
- **R-APP1a** **Assume nothing about the machine** (maintainer decision, 2026-07-03). A
  packaged Tauri build must not presume any tool — including the **Node runtime** — is
  present. The app **detects** what's installed and **guides** the user to supply what's
  missing (§6, and the packaging decision in VS-89: bundle vs guided install per tool);
  it never silently fails on a missing dependency.
- **R-APP2** The Rust shell spawns a **long-lived Node subprocess** (the *sidecar host*,
  §5) via `tauri-plugin-shell` / `std::process::Command`, and communicates with it over a
  typed request/stream protocol (§5). This is the glassbox pattern (Rust shell → Node
  pipeline → webview) applied 1:1. Per R-APP1a the Node runtime the shell spawns is
  **detected-or-provided**, not assumed (bundled-sidecar vs guided-install decided at
  packaging, VS-89).
- **R-APP3** The app **reuses the existing pipeline as-is** — it must not fork or
  reimplement `tools/*.mjs`, `dist/analyzer.js`, or `review-switches`. New app code is
  glue (sidecar host, protocol, screens), not engine. It lives in a **subdirectory of this
  repo** (maintainer decision, 2026-07-03) for direct reuse without publishing.
- **R-APP4** macOS-only to start (matches the launcher's platform guard, R2.1); Tauri
  leaves cross-platform open for later without committing to it now.

## 3. Stage navigation & shell chrome

- **R-APP5** The window shows a **left stage rail** with the six stages in order:
  **Setup, New Project, Analyze, Design, Review/Edit, Export** (matching the wireframe).
- **R-APP6** Each stage carries a **visual state**: `done` (artifact present + valid),
  `active` (current), or `locked` (its prerequisites are not met yet). A locked stage is
  not selectable; selecting an available stage swaps the main panel to that screen.
- **R-APP7** Stage state is **derived from the project's artifacts** (§4), not stored
  independently — e.g. Analyze is `done` when the scene timeline + audio-events artifacts
  exist for the current sources, Review is `locked` until a cut (`switches.json`) exists.
  The derivation is a **pure function** of the project state file + artifact presence, so
  it is unit-testable in isolation.

## 4. Project model

- **R-APP8** A **Project** is a folder of source footage (one clip, or many for
  multi-cam) plus a **per-project state file** the app owns (e.g. `.video-studio/project.json`
  inside the project folder). The state file records project name, the source set, and
  **which pipeline artifacts exist** (`sources.json`, `multicam.json`, `audio-events.json`,
  `saliency.json`, `switches.json`, exports).
- **R-APP9** The app can **create** a project (from a picked video or a folder of angles),
  **open** an existing project folder, and list **recent projects**. Recent-projects state
  is app-global config (§6), distinct from per-project state.
- **R-APP10** The state file is **advisory over the filesystem** — artifacts on disk are
  the source of truth; the app re-derives artifact presence on open and reconciles the
  state file, so a project stays valid even if a user edits/deletes an artifact outside
  the app. Reading + reconciling the state is a **pure function** over a directory listing
  (unit-testable; the actual `readdir` is the thin I/O edge).

## 5. Node sidecar host

- **R-APP11** One **long-lived Node process** hosts all pipeline invocations for the app
  session (generalizing the VS-79 spike's one-off analyze call). The Rust shell spawns it
  once, restarts it if it dies, and routes all screen requests through it.
- **R-APP12** The host exposes a **typed request/stream protocol** over stdio (newline-
  delimited JSON, matching glassbox): a request names a **pipeline step** (e.g.
  `analyze-scenes`, `analyze-audio-events`, `sync-multicam`, `propose-switches`,
  `export`) with typed params; the host replies with a stream of **progress events**
  followed by a terminal **result** or **error**. Message framing (`{type, id, ...}`) and
  the request/result/progress/error discriminants are a **pure protocol module** shared by
  both ends and unit-tested to 100%.
- **R-APP13** The host maps each step to the existing tool: scene analysis →
  `dist/analyzer.js`, audio events → `analyze-audio-events.mjs`, saliency →
  `analyze-visual-saliency.mjs`, sources/groups → `analyze-sources.mjs` /
  `propose-groups.mjs`, sync → `sync-multicam.mjs`, switches → `propose-switches`,
  export/render → the existing exporters/renderers. Steps run as child processes (or
  in-process where a tool exposes a pure API) with their **stderr/stdout progress parsed
  into protocol progress events** (VS-60 already emits granular per-call progress).
- **R-APP14** Requests are **cancellable** and **serialized per project** where a step
  mutates shared artifacts; independent read-only steps may run concurrently. A cancelled
  or failed step must leave artifacts in a consistent state (the tools already write
  atomically — the host must not defeat that).
- **R-APP15** Sidecar **lifecycle is observable**: the app surfaces host-down / restarting
  state rather than hanging a screen; an in-flight request whose host dies fails with a
  clear error the screen can retry.

## 6. Setup / doctor screen

- **R-APP16** The Setup screen **reuses the launcher's tool checks** (`checkTools` in
  `bin/video-studio.mjs`) to show green/red status for the engine tools (ffmpeg, ffprobe,
  whisper, ollama), the **Node runtime** (R-APP1a), and the **selected AI agent backend**
  (Claude / Codex / Ollama, per [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md)),
  with the same honesty about the heavy external deps.
- **R-APP17** Consistent with **assume-nothing** (R-APP1a), a missing dependency is never a
  silent failure: the screen **detects and guides** — offering an install path (Homebrew
  where applicable, or the packaged app's guided install, VS-89) and blocking the stages
  that need it with a plain-language reason. Ollama is optional (R2.4); the **AI agent is
  optional** (Auto lane only — the Manual lane needs none); a missing *required* engine tool
  (ffmpeg/whisper) blocks Analyze/Export and says so.

## 7. App-global config

- **R-APP18** App-level settings (recent projects, the selected agent backend, and the
  permission rules of VS-85) live in the **app's own config location** (per-user, e.g. under
  the app's Application Support dir), **separate from** any project folder and from any
  agent's own settings (Claude Code / Codex / Ollama). Reading/merging/writing this config
  is pure over its parsed contents.

## 8. Settled decisions (maintainer, 2026-07-03)

The product forks from [`investigations/ui-app.md`](investigations/ui-app.md) §6 were
resolved by the maintainer on VS-80; the requirements above reflect these:

- **Repo location** → a **subdirectory of this repo** (R-APP3) — direct reuse of
  `tools/*.mjs`, `review-switches`, `dist/analyzer.js` without publishing.
- **Is the AI agent required or optional?** → **optional**, and the agent backend is
  **pluggable**: support **Claude, Codex, and Ollama** to start (initial testing is
  Claude-only). The Manual lane works with no agent. See
  [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md).
- **MVP breadth** → **build both lanes now** (Auto *and* the Manual editor), not an
  Auto-first-only slice.
- **Runtime / dependency UX** → **assume nothing about the machine** (R-APP1a); detect and
  guide the user for anything missing, including the Node runtime. The bundle-vs-guided-
  install choice per tool is finalized at packaging (VS-89).

## 9. Cross-references

- [`investigations/ui-app.md`](investigations/ui-app.md) — the concept, architecture
  options, and phased roadmap (VS-76/78).
- [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md) — the Auto lane's engine
  (VS-83): a pluggable AI agent backend (Claude / Codex / Ollama), structured events → UI.
- [`desktop-app-permissions.md`](desktop-app-permissions.md) — the app-owned safety layer
  (VS-85): category classifier + persisted "always allow" + the Permissions screen.
- The per-screen requirements (Import VS-81, Analyze VS-82, Design VS-86, Review VS-87,
  Export VS-88) and packaging (VS-89) get their own docs as those tickets are worked.

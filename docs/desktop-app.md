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

Status: **Partial** — the **native Tauri shell is scaffolded** (VS-79/VS-90): `desktop/src-tauri`
(Rust) spawns the Node sidecar and streams its events to a vanilla webview (`desktop/ui`) with
the stage rail (R-APP5/6), a Setup/doctor screen (R-APP16/17), and an Analyze screen that runs
`analyze-scenes` with live streamed progress. The sidecar protocol/steps/doctor cores
(`desktop/sidecar/*.mjs`, R-APP12/13/16/17) are unit-tested to 100%. **Remaining:** the persisted
project model (R-APP8–10), the New Project / Design / Review / Export screens, and packaging.
Run the app with `npm run desktop:dev`.

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

- **R-APP5** *(built — `desktop/ui`)* The window shows a **left stage rail** with the six
  stages in order: **Setup, New Project, Analyze, Design, Review/Edit, Export** (matching the
  wireframe).
- **R-APP6** *(partial — `desktop/ui`)* Each stage carries a **visual state**: `active`
  (current) or `locked` (not wired yet — not selectable); the full `done` (artifact present +
  valid) derivation lands with the project model (R-APP7–10). Selecting an available stage
  swaps the main panel to that screen.
- **R-APP7** *(built — `desktop/sidecar/project.mjs` `deriveStages`)* Stage state is
  **derived from the project's artifacts** (§4), not stored independently — e.g. Analyze is
  `done` when the audio-events artifact exists, Review is `locked` until a cut
  (`switches.json`) exists. The derivation is a **pure function** of artifact presence + the
  selected stage, unit-tested to 100%.

## 4. Project model

- **R-APP8** *(built — `desktop/sidecar/project.mjs`)* A **Project** is a folder of source
  footage (one clip, or many for multi-cam) plus a **per-project state file** the app owns
  (`.video-studio/project.json` inside the project folder). The state file records project
  name, the source set, and **which pipeline artifacts exist** (`sources.json`,
  `multicam.json`, `audio-events.json`, `saliency.json`, `switches.json`, exports — the
  `ARTIFACTS` map). The state shape + `newProjectState` are pure + unit-tested; the file
  read/write is host I/O (`project-open`/`project-create` steps).
- **R-APP9** *(built — logic)* The app can **create** a project and **open** an existing
  project folder (the New Project screen + the `open_folder` dialog + the host steps), and
  **recent projects** persist via `config.mjs` `addRecentProject` (dedupe + cap) + the
  `config-add-recent`/`config-get` host steps. The recents *list UI* is the remaining manual
  piece.
- **R-APP10** *(built — `reconcileProject`)* The state file is **advisory over the
  filesystem** — artifacts on disk are the source of truth; the app re-derives artifact
  presence on open and reconciles the state file, so a project stays valid even if a user
  edits/deletes an artifact outside the app. Reconciliation is a **pure function** over a
  directory listing (100% unit-tested; the actual `readdir` is the thin I/O edge).

## 5. Node sidecar host

- **R-APP11** One **long-lived Node process** hosts all pipeline invocations for the app
  session (generalizing the VS-79 spike's one-off analyze call). The Rust shell spawns it
  once, restarts it if it dies, and routes all screen requests through it.
- **R-APP12** *(built — `desktop/sidecar/protocol.mjs`)* The host exposes a **typed
  request/stream protocol** over stdio (newline-delimited JSON, matching glassbox): a
  request names a **pipeline step** (e.g. `analyze-scenes`, `analyze-audio-events`,
  `analyze-sources`) with typed params; the host replies with a stream of **progress
  events** followed by a terminal **result** or **error**. Message framing (`{type, id,
  ...}`), the request/result/progress/error discriminants, and request validation are a
  **pure protocol module** shared by both ends and **unit-tested to 100%**
  (`tests/sidecar-protocol.test.mjs`). The stdin/stdout plumbing is the thin I/O edge
  (`host.mjs`, manual).
- **R-APP13** *(built — `desktop/sidecar/steps.mjs`)* The host maps each step to the
  existing tool via a **pure step registry**: scene analysis → `dist/analyzer.js`, audio
  events → `analyze-audio-events.mjs`, sources → `analyze-sources.mjs` (extensible to
  saliency / `sync-multicam` / `propose-switches` / the exporters). Each step's
  `buildCommand` descriptor (logical tool + argv) and its **progress parser** (e.g. the
  real `dist/analyzer.js` status lines → normalized progress) are pure and **100%
  unit-tested**; steps run as child processes with their stdout/stderr parsed into
  protocol progress events (VS-60 already emits granular per-call progress). The spawn
  itself is the I/O edge (`host.mjs`, manual).
- **R-APP14** Requests are **cancellable** and **serialized per project** where a step
  mutates shared artifacts; independent read-only steps may run concurrently. A cancelled
  or failed step must leave artifacts in a consistent state (the tools already write
  atomically — the host must not defeat that).
- **R-APP15** Sidecar **lifecycle is observable**: the app surfaces host-down / restarting
  state rather than hanging a screen; an in-flight request whose host dies fails with a
  clear error the screen can retry.

## 6. Setup / doctor screen

- **R-APP16** *(built — `desktop/sidecar/doctor.mjs` + the Setup screen)* The Setup screen
  probes tool presence (the `doctor` sidecar step) and shows green/red status for the engine
  tools (ffmpeg, ffprobe, whisper, ollama), the **Node runtime** (R-APP1a), and the AI agent
  (Claude; Codex/Ollama per [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md)),
  with the same honesty about the heavy external deps. The rows + readiness verdict
  (`doctorResultFromChecks`) are pure + 100% unit-tested.
- **R-APP17** *(partial)* Consistent with **assume-nothing** (R-APP1a), a missing dependency
  is never a silent failure: the Setup screen shows each missing tool with a plain-language
  **install hint**. Full stage-gating (blocking Analyze/Export on a missing *required* engine
  tool) + the one-click install path (Homebrew / the packaged app's guided install, VS-89)
  land with the project model + packaging. Ollama is optional (R2.4); the **AI agent is
  optional** (Auto lane only — the Manual lane needs none).

## 7. App-global config

- **R-APP18** *(built — `desktop/sidecar/config.mjs`)* App-level settings (recent projects,
  the selected agent backend, and the permission policy + rules of VS-92) live in the **app's
  own config location** (`~/Library/Application Support/video-studio/config.json`), **separate
  from** any project folder and from any agent's own settings (Claude Code / Codex / Ollama).
  The config shape + tolerant `parseConfig` + the immutable transforms are pure + 100%
  unit-tested; the host's `config-*` steps do the file read/write.

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
- [`desktop-app-import.md`](desktop-app-import.md) — the New Project + import stage (VS-81):
  single-source-vs-multi-cam detection writing the first artifact (R-IM).
- [`desktop-app-design.md`](desktop-app-design.md) — the Design stage's two lanes (VS-86).
- [`desktop-app-review.md`](desktop-app-review.md) — the Review stage (VS-87).
- [`desktop-app-export.md`](desktop-app-export.md) — the Export lane (VS-88).
- The remaining per-screen requirements (Analyze VS-82) and packaging (VS-89) get their own
  docs as those tickets are worked.

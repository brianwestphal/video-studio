# Investigation: video-studio as a desktop UI app (VS-76)

Status: **investigation / brainstorm** — no implementation yet. This proposes a concept and
a phased plan; the maintainer reviews before we build. Follow-up tickets are filed for the
proposed work (see the end).

## 1. Why

Everything we've built is a CLI pipeline plus a Claude Code skill. That's excellent for
technical users, but the front door is a terminal, JSON artifacts, and multi-step commands —
overwhelming for the people who most want the *output*: musicians, videographers, and other
visual creatives who think in **timelines, previews, and buttons**, not `--flags` and
`switches.json`. The ask: a friendlier **visual app** that runs the *same* pipeline and the
*same* external dependencies underneath, so we don't fork the engine — we add a face.

## 2. We already have most of the pieces (big head start)

This is not a rewrite; it's a shell around what exists.

- **The engine is already modular + headless.** Each stage is a small Node CLI over a pure,
  tested core (`tools/*.mjs`, `dist/analyzer.js`) that reads/writes JSON artifacts
  (`sources.json`, `multicam.json`, `audio-events.json`, `saliency.json`, `switches.json`,
  the export manifest). An app just needs to *invoke* these and visualize their artifacts.
- **We already ship a real editor UI.** `tools/review-switches.mjs` serves a **vanilla
  HTML/JS** page with synchronized multi-angle video playback, a whole-video timeline,
  scrubbing, angle-picking, split, and a live assembled preview (VS-65/71/72/73/74). That is
  already the hard part of a visual editor — and it's browser-native, so it drops straight
  into a webview.
- **We already have a "doctor."** The launcher (`bin/video-studio.mjs`) checks
  ffmpeg/ffprobe/whisper/ollama/claude and offers Homebrew installs. That becomes the app's
  first-run setup screen almost verbatim.
- **The maintainer already has a Tauri pattern.** `~/Documents/hotsheet` and
  `~/Documents/glassbox` are Tauri apps with **vanilla/TS webview frontends** (no React/Svelte)
  and a Rust shell that **spawns a Node subprocess via `tauri-plugin-shell` /
  `std::process::Command::new("node")` and streams its stdout to the UI** (glassbox does
  exactly this). video-studio maps onto that pattern 1:1: Rust shell → Node pipeline → webview.

## 3. What the app should be (concept)

A **guided project workspace** that walks a creative from *"drop in footage"* to *"finished
cut"* without a terminal — while keeping the power users' escape hatches.

- **Unit of work = a Project**: a folder of source footage (one clip, or many for multi-cam).
- **A left rail of pipeline stages**, each a visual panel, with live progress:
  **Import → Analyze → Design the cut → Review/Edit → Export.**
- **Two lanes, same engine** (this is the key product idea):
  - **Auto lane** — a prompt box: *"a punchy 15-second teaser"* / *"a 9:16 reel of the chorus."*
    Under the hood this is the existing Claude skill / agent driving the pipeline. The creative
    describes intent; the app produces a cut to review.
  - **Manual lane** — the visual timeline (the existing review UI, expanded) for people who
    want to place cuts, pick angles, and trim by hand.
  - They meet in the middle: Auto proposes, Manual refines. Every auto decision is an editable
    artifact, so "AI did 90%, I tweaked 10%" is the natural flow.
- **Claude is the brain, not the surface.** The terminal/agent stays available under the hood;
  the app is the friendly face over it.

## 4. MVP screens

1. **Setup / doctor** — green/red tool checks (reuse the launcher's `checkTools`), one-click
   "install with Homebrew" guidance. Honest about the heavy external deps.
2. **New Project** — pick a video, or a folder of multi-cam clips; name the project.
3. **Analyze** — run scene analysis / audio events / (multi-cam) sync + saliency, with **live
   per-stage progress** (we already added granular vision-pass progress in VS-60) and a
   scene-contact-sheet thumbnail wall.
4. **Design** — the Auto prompt box (→ Claude proposes a cut) and/or jump straight to Manual.
5. **Review / Edit** — the existing review UI: synchronized angle player, whole-video timeline,
   pick/split, live assembled preview.
6. **Export** — buttons: **MP4**, **9:16 social**, **Final Cut Pro (FCPXML) handoff**, each with
   a progress bar; reveal the output in Finder when done.

## 5. Architecture options

**Option A — Tauri shell over the existing Node pipeline. (Recommended.)**
- Tauri (Rust) window; frontend is a webview that reuses/extends the `review-switches` HTML/JS.
  Rust spawns Node (see §6) to run `tools/*.mjs` + `dist/analyzer.js`, streaming stdout →
  progress events to the UI — the glassbox pattern. External tools (ffmpeg/whisper/ollama/
  claude) stay external and are detected by the existing doctor.
- **Pros:** maximal reuse (pipeline, review UI, doctor); matches the maintainer's Tauri muscle
  memory; small native binary; native file dialogs / menus / "reveal in Finder"; no engine
  rewrite. The riskiest UI (the editor) already exists.
- **Cons:** still requires the heavy external tools to be installed (they *are* the engine —
  unavoidable in any packaging); we must decide how Node is provided (§6).

**Option B — Electron.** Node is built in (no sidecar decision), but heavier binaries and it
diverges from the maintainer's standardized Tauri toolchain. Rejected on consistency + weight.

**Option C — pure local web app (no native shell).** A browser can't run ffmpeg/whisper/ollama
locally without a native host process, which is the whole point. Rejected.

→ **Recommend Option A.**

## 6. Open decisions for the maintainer (product forks)

These change scope materially — worth deciding before building:

1. **Is Claude required or optional?** Auto lane needs Claude Code (agentic). Is the app
   "Claude-powered" (requires it, handles its auth in a GUI) or does it ship a **manual-only**
   mode that works with just ffmpeg/whisper/ollama? Biggest fork.
2. **Node runtime:** bundle a Node sidecar (self-contained, bigger) or require system Node
   (lighter, another install to check)? glassbox spawns system `node` — likely follow suit.
3. **External-dependency UX:** ffmpeg/whisper/ollama are large. Guide via Homebrew (like the
   launcher) or bundle what we can (e.g. a static ffmpeg)? Whisper + Ollama models are heavy and
   probably stay guided installs.
4. **MVP breadth:** ship the **Auto lane first** (a thin, high-wow wrapper around the skill:
   "drop video → describe → get cut → export") and add the Manual editor after? Or lead with the
   Manual editor (the review UI already exists)? Recommendation: a **narrow Auto-first slice**
   for the wow factor, with the existing review UI embedded as the "refine" step.
5. **Platform:** macOS-only to start (matches today); Tauri leaves cross-platform open later.

## 7. Recommendation

**Yes — worth doing, via Option A, but start narrow to de-risk.** The single unknown is the
**native-shell ↔ Node-pipeline ↔ webview** bridge (spawning Node, streaming progress, file
dialogs). Everything else (engine, editor UI, doctor) already exists. So:

- **First, a thin spike** proving the bridge: a Tauri window with the doctor screen, "open a
  video," run **Analyze** with live progress streamed from the Node subprocess. If that feels
  good, the rest is assembly.
- **Then embed the review UI** as the edit surface, **then** wire the Auto + Export lanes, and
  finally **packaging/signing**.

Do **not** build the whole thing up front; each phase is independently useful and reviewable.

## 8. Proposed phased roadmap (→ follow-up tickets)

- **Phase 0 (design):** app concept + clickable wireframes for the six screens and the two
  lanes. *(ticket filed)*
- **Phase 1 (spike):** Tauri shell — doctor + open-project + Analyze-with-live-progress over a
  Node subprocess. De-risks the whole approach. *(ticket filed)*
- **Phase 2:** embed the `review-switches` editor (player + timeline + pick/split) as the app's
  Review/Edit surface. *(to ticket after the spike)*
- **Phase 3:** Auto lane (Claude-driven "describe your cut") + Export lane (MP4 / 9:16 / FCPXML)
  with progress + reveal-in-Finder. *(to ticket after the spike)*
- **Phase 4:** packaging — bundle/notarize/sign, first-run dependency-install UX, distribution.
  *(to ticket after the spike)*

Phases 2–4 are intentionally left un-ticketed until the Phase-0 design and Phase-1 spike settle
the open decisions in §6 — filing them now would be guessing at scope.

## 9. How the app drives Claude (control channel)

The maintainer's instinct is to embed a single fixed terminal (like `~/Documents/hotsheet`'s
terminals, minus the dynamic creation) running the `claude` CLI, and detect login / permission /
question states from it. That works, but **scraping the interactive TUI for control flow is
fragile** — it means parsing ANSI/redraw output that changes across Claude Code versions. There's
a purpose-built alternative that removes the guesswork (facts verified against the Claude Code
docs — headless / agent-sdk / permissions / authentication pages).

**Primary control channel = the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), not TUI
scraping.** Run Claude Code headlessly from the same Node sidecar the Rust shell already spawns
(glassbox pattern). It yields **structured, streamed events** — `system`/`init` (with
`session_id`), `assistant` messages, `tool_use`, `tool_result`, `result` — so there's nothing to
scrape. The load-bearing pieces for exactly the cases the maintainer listed:

- **Permission checks + questions → the `canUseTool(toolName, input)` callback.** When Claude
  wants a tool that isn't pre-approved, the SDK invokes this callback; the app renders its **own
  native approve/deny UI** and returns `{behavior:"allow"}` / `{behavior:"deny"}`. The
  **`AskUserQuestion`** tool arrives through the same callback (with a `questions[]` + `options`
  payload), so "Claude is asking something" becomes a friendly native picker whose answer we feed
  back. No terminal parsing. (Caveat: pre-approved tools never reach the callback; the raw headless
  CLI has no `canUseTool` — that capability is why we prefer the SDK over the bare CLI.)
- **Presenting Claude's work → consume the structured events** (`assistant` text, `tool_use`,
  `tool_result`) and map them to friendly UI ("Analyzing scenes ✓", "Proposed a 15 s teaser",
  list the generated files). Even better, since we own the prompt/skill, ask Claude for a
  **structured result (JSON-schema output)** — a cut plan the app renders directly — instead of
  parsing prose.
- **Constrain the surface.** Pre-approve our own pipeline tools via `allowedTools` (or expose the
  pipeline as an **MCP server the app provides**) so a non-technical user is only ever prompted for
  genuinely novel/risky actions — far fewer scary dialogs.

**Where a real terminal (PTY) still earns its place — keep it, but scoped:**

- **Login / auth.** Headless runs need a credential (`ANTHROPIC_API_KEY`, a `CLAUDE_CODE_OAUTH_TOKEN`
  from `claude setup-token`, or a cloud-provider env), and interactive OAuth login is inherently a
  terminal + browser flow. **Detect "not authenticated"** from a failed headless run (auth error /
  non-zero exit), then present a "Connect your Claude account" step that either runs the interactive
  login in an embedded PTY (reuse hotsheet's xterm+PTY) or accepts a pasted key — stored in the
  macOS Keychain.
- **Power-user / debug drawer.** An optional, usually-hidden terminal mirroring the raw session:
  reassuring for technical users, invaluable for support ("show me the logs").

So the shape is **SDK for control + presentation; terminal for login + optional visibility**, both
hosted in the one Node sidecar. This directly answers the maintainer's detection list without
betting the UX on TUI scraping.

**Decisions this raises (for Phase 0 / VS-78):**
- **SDK vs raw headless CLI** — the SDK's `canUseTool` is what makes the native approval/question UI
  possible; the bare CLI can only pre-allow/deny by name. → lean SDK.
- **Auth model in a GUI** — API key vs OAuth token vs `setup-token`; Keychain storage; how to make
  first-run login painless.
- **How agentic to be** — a freewheeling agent (more permission prompts) vs a tightly tool-scoped
  agent that returns a structured cut plan (fewer prompts, more legible) — the latter is friendlier
  for non-technical users.
- **Version-pin** the SDK/CLI and tolerate unknown event types (the event schema evolves).

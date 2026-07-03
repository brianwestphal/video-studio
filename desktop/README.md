# desktop/ — video-studio desktop app (VS-76)

The native app front door over the existing pipeline — a **Tauri shell → long-lived Node
sidecar → vanilla webview** (the `~/Documents/glassbox` pattern), living in a subdirectory
of this repo so it reuses `tools/*.mjs`, `review-switches`, and `dist/analyzer.js` directly
without publishing.

Requirements: [`../docs/desktop-app.md`](../docs/desktop-app.md) (R-APP),
[`../docs/desktop-app-agent-bridge.md`](../docs/desktop-app-agent-bridge.md) (R-CB, Auto
lane), [`../docs/desktop-app-permissions.md`](../docs/desktop-app-permissions.md) (R-PERM).
Concept + roadmap: [`../docs/investigations/ui-app.md`](../docs/investigations/ui-app.md).

## Layout

- **`sidecar/`** — the Node sidecar host the Rust shell spawns.
  - **`protocol.mjs`** — pure NDJSON request/stream protocol: framing, request validation,
    message constructors (R-APP12). Unit-tested to 100% (`../tests/sidecar-protocol.test.mjs`).
  - **`steps.mjs`** — pure step registry: each pipeline step's `buildCommand` descriptor
    (logical tool + argv) and progress parser (e.g. the real `dist/analyzer.js` status
    lines → normalized progress) (R-APP13). Unit-tested to 100%.
  - **`doctor.mjs`** — pure tool list + `doctorResultFromChecks` for the Setup screen
    (R-APP16/17). Unit-tested to 100%.
  - **`host.mjs`** — the I/O edge: reads NDJSON requests on stdin, spawns the mapped tool as
    a child process (or fans out `which` probes for the `doctor` step), streams parsed
    progress + a terminal result/error on stdout, handles cancel + a `ready` handshake.
    Manual-tested — see [`../docs/manual-test-plan.md`](../docs/manual-test-plan.md) §14.
- **`src-tauri/`** — the native Tauri (Rust) shell. `src/lib.rs` spawns `host.mjs`, forwards
  each stdout line to the webview as a `sidecar` event, and exposes the `sidecar_send`
  (write a request to the host's stdin) + `open_video` (native file dialog) commands. The
  host script path resolves from `CARGO_MANIFEST_DIR` (bundled-resource packaging = VS-89).
- **`ui/`** — the vanilla webview frontend (`frontendDist`): the left **stage rail**
  (R-APP5/6), the **Setup/doctor** screen, and the **Analyze** screen (open a video → run
  `analyze-scenes` with live streamed progress). No framework, no build step.

## Running (dev)

The window loads the embedded `ui/` frontend — no dev server, no Tauri CLI needed:

```sh
npm run desktop:dev          # = cargo run --manifest-path desktop/src-tauri/Cargo.toml
```

Requires the Rust toolchain (`cargo`) and `node` on PATH. Bundling / signing a `.app`/`.dmg`
(the Tauri CLI + `tauri build`) is deferred to packaging (VS-89).

## Running the sidecar host directly (manual, no window)

```sh
# from the repo root, after `npm run build` (so dist/analyzer.js exists):
echo '{"type":"request","id":1,"step":"analyze-scenes","params":{"video":"clip.mp4"}}' \
  | node desktop/sidecar/host.mjs
# → {"type":"ready"} then a stream of {"type":"progress",...} and a terminal {"type":"result",...}
```

## Not built yet

The New Project / Design / Review / Export screens (shown **locked** in the rail), the
persisted project model, and the AI-agent Auto lane. Tracked by VS-90 + the per-screen
tickets (VS-81/82/86/87/88) and the agent bridge (VS-91/93/94).

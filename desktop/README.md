# desktop/ — video-studio desktop app (VS-76)

The native app front door over the existing pipeline — a **Tauri shell → long-lived Node
sidecar → vanilla webview** (the `~/Documents/glassbox` pattern), living in a subdirectory
of this repo so it reuses `tools/*.mjs`, `review-switches`, and `dist/analyzer.js` directly
without publishing.

Requirements: [`../docs/desktop-app.md`](../docs/desktop-app.md) (R-APP),
[`../docs/desktop-app-agent-bridge.md`](../docs/desktop-app-agent-bridge.md) (R-CB, Auto
lane), [`../docs/desktop-app-permissions.md`](../docs/desktop-app-permissions.md) (R-PERM).
Concept + roadmap: [`../docs/investigations/ui-app.md`](../docs/investigations/ui-app.md).

## What's here so far

- **`sidecar/`** — the Node sidecar host the Rust shell will spawn.
  - **`protocol.mjs`** — pure NDJSON request/stream protocol: framing, request validation,
    message constructors (R-APP12). Unit-tested to 100% (`../tests/sidecar-protocol.test.mjs`).
  - **`steps.mjs`** — pure step registry: each pipeline step's `buildCommand` descriptor
    (logical tool + argv) and progress parser (e.g. the real `dist/analyzer.js` status
    lines → normalized progress) (R-APP13). Unit-tested to 100%.
  - **`host.mjs`** — the I/O edge: reads NDJSON requests on stdin, spawns the mapped tool as
    a child process, streams parsed progress + a terminal result/error on stdout, handles
    cancel + a `ready` handshake. Manual-tested (external tools) — see
    [`../docs/manual-test-plan.md`](../docs/manual-test-plan.md).

## Not built yet

The native Tauri shell (Rust window + `tauri-plugin-shell` spawning `host.mjs` + emitting
its stdout as Tauri events), the webview frontend (stage rail + screens), the project model,
and the doctor screen. Tracked by **VS-90** and the per-screen tickets.

## Running the sidecar host directly (manual)

```sh
# from the repo root, after `npm run build` (so dist/analyzer.js exists):
echo '{"type":"request","id":1,"step":"analyze-scenes","params":{"video":"clip.mp4"}}' \
  | node desktop/sidecar/host.mjs
# → {"type":"ready"} then a stream of {"type":"progress",...} and a terminal {"type":"result",...}
```

# Desktop app — optional timeline editor (VS-87, VS-113)

Design's optional timeline action mounts the **already-shipped** review UI
(`tools/review-switches.mjs` — synced multi-angle player, whole-video timeline, pick/split,
live assembled preview, force-add, section band; VS-65/71/72/73/74, R-RUI in
[`multicam-review-ui.md`](multicam-review-ui.md)) inside the app. It is the lowest-risk
screen — the hard part already exists — so the app **reuses its local server** rather than
re-porting the page.

Part of the desktop-app initiative — see the umbrella [`desktop-app.md`](desktop-app.md).
Status: **Shipped** — the server lifecycle + iframe embed are built. VS-113 removed Review
as a mandatory rail stage and moved the embed into Design, so a completed cut unlocks Export
without forcing users through a redundant screen.

## 1. Reuse the server, embed via iframe

- **R-RV1** The app runs the shipped `review-switches` server **from the sidecar** — a
  `review-start` step spawns it for the current project (`multicam.json` + `switches.json`,
  plus `audio-events.json`/`saliency.json` when present for re-propose) with a new
  **`--no-open`** flag (so it doesn't pop the system browser), reads back the
  `http://127.0.0.1:<port>/` URL from its startup line (`parseReviewUrl`, pure + tested),
  and returns it. It is **one long-lived server**, reused across visits and stopped on
  `review-stop` / host exit; the argv is a **pure** function (`reviewCommand`, unit-tested).
- **R-RV2** Design **embeds** that URL in an **iframe** when the user chooses **Open timeline
  editor** (least churn — the page is browser-native). The action starts/reuses the server
  and points the iframe at it; a missing project or unsupported single-source cut shows a
  plain-language prompt instead.

## 2. Flagged-first + the write-back handoff

- **R-RV3** The embedded UI **surfaces the flagged "needs a look" cuts first** (the Auto →
  Manual handoff — this is the review UI's existing default, R-RUI2), and the user's picks
  write back to the same hand-editable **`switches.json`** the exporters read (R-AC7), so
  Design → Export is seamless. No new review logic is added here; the surface is glue over the
  shipped tool.

## 3. Cross-references

- [`multicam-review-ui.md`](multicam-review-ui.md) — the review UI itself (R-RUI).
- [`desktop-app.md`](desktop-app.md) — the sidecar host + project model.
- [`desktop-app-export.md`](desktop-app-export.md) — consumes the reviewed `switches.json`.

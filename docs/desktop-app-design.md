# Desktop app — Design and optional timeline editing (VS-86, VS-113)

The Design stage is the creative workspace: a user **describes** the cut they want (Auto),
then either continues directly to Export or **opens the timeline** for optional hands-on
multi-camera refinement. Both operate on the same editable `switches.json` that Export renders.

Part of the desktop-app initiative — see [`desktop-app.md`](desktop-app.md),
[`desktop-app-review.md`](desktop-app-review.md), and
[`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md).

Status: **Shipped** — Auto produces a cut, Export unlocks immediately, and an optional
multi-camera timeline editor is available in Design. VS-113 removed the confusing mandatory
Review rail stage and consolidated its editor into this screen.

## 1. The screen

- **R-DS1** The Design stage presents an **Auto** lane (a prompt box + one-click presets —
  *Teaser / Full song / 9:16 reel / Soundbites*) and an optional **Timeline editing** action.
  It makes clear that a completed cut can continue directly to Export and that multi-camera
  output remains editable (R-DS4).

## 2. Manual lane — open the timeline with an auto starting point

- **R-DS2** *(built, refined in VS-113)* "Open timeline editor" expands the editor inside
  **Design**. If the project has no cut yet, it first proposes an **auto starting point** — `propose-switches` over the
  project's `multicam.json` (+ `audio-events.json`/`saliency.json` when present) writing
  `switches.json` — then refreshes the project and opens the editor. The argv is a **pure**
  function (`proposeCommand`, unit-tested); the spawn is the `design-cut` host step (I/O).

## 3. Auto lane — describe → an agent proposes

- **R-DS3** *(built)* "Make my cut" hands the prompt to the **AI agent bridge**
  ([`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md)), which drives the pipeline
  and returns a proposed cut (a validated cut plan / `switches.json` or `cut.json`) ready for
  Export. The optional timeline remains available for multi-camera refinement.

## 4. The handoff

- **R-DS4** Auto **proposes**, the timeline editor optionally **refines**: both use the same
  hand-editable `switches.json` (R-RV3). The usual path is Design → Export; users who need
  angle or split-point changes stay in Design and open the editor. There is no duplicate,
  mandatory Review stage.

## 5. Cross-references

- [`desktop-app-review.md`](desktop-app-review.md) — the optional embedded timeline (VS-87/113).
- [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md) — the Auto lane's engine (VS-91).
- [`multicam-auto-cut.md`](multicam-auto-cut.md) — `propose-switches` (the auto starting point).

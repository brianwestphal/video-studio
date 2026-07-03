# Desktop app — Design stage (two lanes) (VS-86)

The Design stage (wireframe screen 04) is the core **"two lanes, one engine"** idea: a
creative either **describes** the cut they want (Auto) or **opens the timeline** and cuts by
hand (Manual). Both land on the same editable `switches.json` the Review stage refines and
the Export stage renders.

Part of the desktop-app initiative — see [`desktop-app.md`](desktop-app.md),
[`desktop-app-review.md`](desktop-app-review.md), and
[`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md).

Status: **Partial** — the **Manual lane is functional** and the two-lane screen is built; the
**Auto lane** shows an honest "connect an agent" state until VS-91's live Claude backend is
wired. Depends on VS-90 (shell + project model); the Auto lane depends on VS-91/VS-83.

## 1. The screen

- **R-DS1** The Design stage presents **two lanes** side by side: an **Auto** lane (a prompt
  box + one-click presets — *Teaser / Full song / 9:16 reel / Soundbites* that fill the
  prompt) and a **Manual** lane (Open the timeline). It makes clear that auto output is fully
  editable (R-DS4).

## 2. Manual lane — open the timeline with an auto starting point

- **R-DS2** *(built)* "Open the timeline" jumps to the **Review** stage. If the project has no
  cut yet, it first proposes an **auto starting point** — `propose-switches` over the
  project's `multicam.json` (+ `audio-events.json`/`saliency.json` when present) writing
  `switches.json` — then refreshes the project and opens Review. The argv is a **pure**
  function (`proposeCommand`, unit-tested); the spawn is the `design-cut` host step (I/O).

## 3. Auto lane — describe → an agent proposes

- **R-DS3** *(partial)* "Make my cut" hands the prompt to the **AI agent bridge**
  ([`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md)), which drives the pipeline
  and returns a proposed cut (a validated cut plan / `switches.json`) ready for Review. Until
  the **live backend (VS-91 R-CB3)** is wired, the Auto lane surfaces a clear **"connect an
  AI agent"** state rather than a fake result — it never pretends to have produced a cut.

## 4. The handoff

- **R-DS4** Auto **proposes**, Review **refines**: whichever lane a user starts in, the result
  is the same hand-editable `switches.json` opened in the Review timeline (R-RV3). "The AI did
  90%, I tweaked 10%" is the natural flow; there is no separate, locked "auto" output.

## 5. Cross-references

- [`desktop-app-review.md`](desktop-app-review.md) — where both lanes land (VS-87).
- [`desktop-app-agent-bridge.md`](desktop-app-agent-bridge.md) — the Auto lane's engine (VS-91).
- [`multicam-auto-cut.md`](multicam-auto-cut.md) — `propose-switches` (the auto starting point).

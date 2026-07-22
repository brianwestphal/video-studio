# Desktop app — New Project + import (VS-81)

The **New Project** stage (wireframe screen 02) is the app's front door: a creative points it
at their footage — a **single video** or a **folder of camera angles** — and the app detects
which it is, writes the first project artifact, and unlocks the rest of the pipeline. It is the
step that turns a bare folder into a video-studio project.

Part of the desktop-app initiative — see [`desktop-app.md`](desktop-app.md). Import feeds the
[Analyze](desktop-app.md) stage and, from there, [Design](desktop-app-design.md).

Status: **Partial** — single-source-vs-multi-cam **detection is built and functional**: opening
a folder and clicking *Analyze this footage* creates `sources.json` (single) or `multicam.json`
(multi-cam) and lights up the rail. Recent projects are persisted and reopenable from the New
Project screen (R-IM6, VS-112). The **group proposal** for a mixed folder (R-IM5) remains a
follow-up. Depends on VS-90 (shell + project model + sidecar host).

## 1. The screen

- **R-IM1** The New Project screen lets a user **Open** an existing project folder or **Create**
  a project over a footage folder — a single video, or a folder of camera angles. It shows the
  project name and the artifact chips already present. When the opened folder has no artifacts
  yet it shows an honest empty state ("No footage imported yet…") and an **Analyze this footage**
  action rather than a misleading "run Analyze" prompt into a locked stage. *(built — GUI;
  manual-test-plan §15.6-15.7, §15.15.)*

## 2. Recognizing the footage

- **R-IM2** The importer recognizes the **video files** in a folder by extension
  (`.mp4 .mov .m4v .mkv .webm .avi`), case-insensitively, returning them **sorted** and ignoring
  everything else (JSON artifacts, notes, images). A folder with **no** video files is an honest
  error ("no video files found") — never a silent empty import. This is the pure `videoFilesIn`
  (unit-tested); the `readdir` that feeds it is the host's I/O edge.

## 3. Single-source vs multi-cam detection

- **R-IM3** From the recognized videos the app **detects the project shape** and builds the
  import command (pure `importCommand`):
  - **one video → single-source** — `analyze-sources` over that video writes `sources.json`
    (`kind: "single"`, `count: 1`).
  - **two or more videos → multi-cam** — `sync-multicam` audio-syncs the angles into
    `multicam.json` (`kind: "multicam"`, `count: N`).

  The argv + output path are a pure function; only the folder listing and the child-process
  spawn are I/O. See [`multiple-sources.md`](multiple-sources.md) (single-source analysis) and
  [`multicam-sync.md`](multicam-sync.md) (angle audio-sync).

## 4. Writing the first artifact + unlocking the rail

- **R-IM4** The host **`import-footage`** step does the `readdir`, resolves the command via
  `importCommand`, spawns the tool, and on success **refreshes the project** so the artifact it
  wrote (`sources.json` / `multicam.json`) is reconciled into the stage state (R-APP10). The rail
  then advances: **New Project → done**, and **Analyze / Design** become reachable (the "Synced N
  angles" / single-source confirmation). This is the fix for the original New-Project dead-end,
  where opening a folder only *read* it and left Analyze locked. *(GUI/I-O; manual-test-plan
  §15.15.)*

## 5. Follow-ups (documented, not yet built)

- **R-IM5** *(partial)* **Group proposal** for a folder that is **not** a single group: reuse
  `propose-groups` / [`multicam-groups`](multicam.md) to detect multiple angle groups, and show
  the **detected shape** ("4 angles, 3:59, multi-cam") for the user to **confirm before syncing**.
  Today every video in the folder is synced as one group (R-IM3), which is correct for the common
  single-group case but does not split a folder that holds several shoots. The pure detection
  core (`describeImportShape` — single / multicam / multi-group + the human summary, unit-tested)
  is now in place; the analyze-first flow and the confirm-then-sync-per-group host/UI wiring are
  the remaining tail (VS-100).
- **R-IM6** *(built — VS-112)* The **recent-projects list** on New Project reads the app-global
  config store (`addRecentProject`, dedupe + cap — R-APP9 / R-APP18, unit-tested). Each row
  shows the folder name and full path; clicking it reopens the project and promotes it to the
  front of the list. An empty history stays hidden.

## 6. Cross-references

- [`desktop-app.md`](desktop-app.md) — the shell, project model, stage rail, and sidecar host
  (VS-90) this stage builds on.
- [`multicam-sync.md`](multicam-sync.md) — `sync-multicam` (the multi-cam import path).
- [`multiple-sources.md`](multiple-sources.md) — `analyze-sources` (the single-source path).
- [`multicam.md`](multicam.md) — grouping / `propose-groups` (the R-IM5 follow-up).
- [`desktop-app-design.md`](desktop-app-design.md) — the next creative stage after Analyze.

---
name: prep-major-release
description: Prepare video-studio for a major release — refresh the README so it stays compelling and advertises the best features, upgrade domotion-svg to the latest and rebuild the generated demos, then review the demo media (screenshots / GIFs / sample clips) and hand the maintainer a precise capture list. Use before cutting a notable/major release; pairs with docs/releasing.md (it does NOT publish).
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent
---

Get the project's "shop window" ready for a major release. This skill does the
**presentation** prep — the README and the demo media — not the actual release
(that's `scripts/release.sh` / `docs/releasing.md`). It makes README edits in
place and produces a concrete screenshot/clip **capture list** for the
maintainer, who captures the media (you must not fabricate images).

The maintainer's intent for this skill: *"We've made a lot of changes. Keep the
README compelling and advertising our most important and interesting features.
Review the demo media and revise it if new / different / fewer shots are needed —
I'll capture the new screenshots once you're ready."*

## Step 1 — Figure out what's new since the last release

Build the "what changed and what's worth showing off" picture:

- `git describe --tags --abbrev=0` then `git log <last-tag>..HEAD --oneline` (or the whole history if untagged).
- Read `CHANGELOG.md` (the `Unreleased` section + recent entries).
- Read `docs/ai/requirements-summary.md` for the current Shipped / Partial status, and `docs/requirements.md` for the authoritative feature list.
- Skim recently completed Hot Sheet tickets if relevant.

From this, write a short ranked list of the **most important + most interesting**
capabilities to lead with. "Important" = what most users need; "interesting" =
what makes someone want to try it. The hero of video-studio is *"long video →
finished promo cut, driven from Claude"* — keep that front and centre.

## Step 2 — Review & update `README.md`

Re-read `README.md` against the current reality (`docs/requirements.md`,
`docs/ai/codebase-map.md`, `skills/video-studio/SKILL.md`, `package.json`). Edit
in place so that:

- **The hero lands in the first 3 lines** — what it is + the single most
  compelling thing it does. A skimmer should get it instantly.
- **The top features are advertised prominently** (per the Step 1 ranking) and
  anything stale, less-interesting, or redundant is trimmed. Lead with outcomes
  (teasers, 9:16 social cuts, captions/overlays) before mechanics.
- **The early-concept / experimental disclaimer stays** and stays accurate — do
  not over-promise; this is pre-1.0.
- **Everything still works**: install steps (`npx video-studio …`), every CLI
  flag (`--check` / `--no-launch` / `--skills-only` / `--help`), the build/layout
  table, the dev + release commands, and all relative links resolve. Run
  `node bin/video-studio.mjs --help` and `node dist/analyzer.js --help` (build
  first) to confirm the documented flags match.
- **Tone is consistent and tight** — compelling, concrete, no filler.

Keep `CHANGELOG.md`, `docs/requirements.md`, and the two AI summaries in agreement
with any README claim you change (source/code wins on conflict). If you discover a
real doc-vs-code drift, fix it or file it — don't paper over it in the README.

## Step 3 — Upgrade `domotion-svg`, then rebuild the generated demos

The title-card / caption / overlay demos are rendered with **`domotion-svg`**
(`tools/render-caption.mjs` imports it; `scripts/gen-readme-media.sh` drives it via the
`svg-to-video` binary). Before rebuilding any of that media, make sure the toolkit is on the
**latest** `domotion-svg` so the demos show current output — an out-of-date renderer means
you'd be advertising stale visuals for a *major* release.

1. **Check freshness.** Compare installed vs. latest:
   `npm ls domotion-svg` (installed) against `npm view domotion-svg version` (latest on the
   registry). If they match, skip to Step 4.
2. **Upgrade if out of date.** `npm install domotion-svg@latest` — this bumps the
   `package.json` range **and** refreshes `package-lock.json`. Record the version jump in
   `CHANGELOG.md` (`Unreleased`).
3. **Re-gate immediately.** Run `npm run check` (lint → typecheck → test → build) so any
   breaking change in the new `domotion-svg` surfaces *before* you rebuild media. If its API
   moved, fix the call sites (the imports in `tools/render-caption.mjs` —
   `captureElementTree`, `embedRemoteImages`, `elementTreeToSvgInner`, `generateAnimatedSvg`,
   `optimizeSvg`) and re-gate. If the break is non-trivial or ambiguous, **stop and file a
   ticket / ask the maintainer** rather than forcing it.
4. **Rebuild the generated demos** so they reflect the new renderer:
   `bash scripts/gen-readme-media.sh` (needs a sample video at
   `external/tears-of-steel.mp4` + a Chromium — `npx playwright install chromium`). This
   regenerates the `domotion-svg`-rendered assets in `docs/media/` (teaser, caption overlay).
   These are **real toolkit output**, distinct from the "don't fabricate" screenshots of
   Step 4 (which stay maintainer-captured). If the sample video or Chromium isn't available
   in your environment, don't fake the media — note it and hand the rebuild to the maintainer
   via the capture list (Step 4).

## Step 4 — Review the demo media and write the capture list

video-studio's "demo modes" are how the README/docs *show* the tool working.
Because the output is video, the most persuasive proof is visual: a short
teaser/before-after clip or GIF, a scene-analysis contact sheet, a caption /
lower-third / CTA overlay still, a 9:16 reframe.

1. **Inventory** what visual media the README and `docs/` reference today
   (`grep -rnE '!\[|\.(png|jpe?g|gif|webp|mp4|mov|svg)' README.md docs/`), and
   what exists under any media dir (e.g. `docs/media/`). Note what's missing,
   stale (shows old UI/output), redundant, or too heavy.
2. **Decide new / different / fewer.** Recommend the smallest set of shots that
   best sells *this* release — favour one strong hero clip over many weak
   stills; drop anything that no longer reflects current output. Call out
   anything that should be a lightweight GIF/`.webp` rather than a multi-MB video
   (READMEs render inline media; keep it small).
3. **Write a precise capture list** for the maintainer. For each item give:
   - a short **id/filename** (e.g. `docs/media/teaser-hero.gif`),
   - **what it must show** (the exact scene/interaction/output),
   - **format + rough dimensions** (e.g. GIF/webp, ≤ ~1280px wide, ≤ a few MB),
   - **where it goes** in the README.
   Then **wire placeholders into the README** at those spots — a commented
   `<!-- TODO(prep-major-release): capture docs/media/teaser-hero.gif — … -->`
   plus the intended `![…](path)` so the media drops straight in once captured.
   Do **not** invent or screenshot images yourself; the maintainer captures them.
4. If a media directory or `.gitignore`/`files` handling is needed for the new
   assets, note it (and remember: large binaries in the repo + the npm `files`
   whitelist — decide what should ship vs. stay docs-only).

## Step 5 — Pre-release sanity (no publish)

- Run `npm run check` (lint → typecheck → test → build) and report the result.
- Confirm `CHANGELOG.md` has an `Unreleased`/next-version section capturing the
  headline changes (draft bullets if missing — `scripts/release.sh` will format
  the final entry).
- Do **not** bump the version, tag, or publish — that's `npm run release`
  (`docs/releasing.md`).

## Output / handoff

Produce:

- **README changes** — a bullet summary of what you edited and why.
- **Capture list** — the table from Step 4 (id/filename, what to show, format,
  placement), clearly flagged as *"maintainer to capture"*. This is the thing the
  maintainer is waiting on, so make it copy-pasteable and unambiguous.
- **Follow-ups** — file Hot Sheet tickets (`hs-task`) for anything left open:
  the screenshot/clip capture itself, a `docs/media/` + packaging decision, or
  any doc drift found. Per CLAUDE.md's incomplete-work checklist, any README
  placeholder you inserted MUST have a corresponding follow-up ticket so it
  isn't forgotten.
- **Status** — state plainly that release prep is presentation-only and the
  actual publish still runs through `scripts/release.sh`.

If you need the maintainer to decide something before you can finish (e.g. which
of two hero clips to feature), use a `FEEDBACK NEEDED:` note and wait rather than
guessing.

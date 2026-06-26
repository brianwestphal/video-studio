# video-studio

**Turn a long video into polished promo cuts — driven from [Claude Code](https://docs.claude.com/claude-code).**

video-studio is a macOS toolkit + a Claude skill. You point Claude at a long
recording — a talk, a demo, a screen capture — and ask for a teaser, a vertical
social cut, or a tightened long edit. Claude analyzes the footage, designs the
cut, generates animated overlays, composites everything with ffmpeg, and hands
you a **finished `.mp4`/`.mov`** — not a timeline you still have to render.

> ⚠️ **This is an early concept.** It's an experiment in letting an AI assistant
> drive a real video-editing pipeline end-to-end. It works, but it's rough:
> macOS-only, opinionated, and the interfaces (the skill, the CLI flags, the
> toolkit layout) may change without notice while it's pre-1.0. Treat it as a
> sharp prototype, not a polished product.

---

## What it does

Under the hood it stitches together tools that are each good at one thing:

- **Frame-accurate scene analysis** — ffmpeg does a full-decode scene-cut pass
  and extracts one representative frame per scene. **Claude itself describes the
  frames** (no cloud vision API, no local model required); optionally Ollama can
  auto-describe them offline.
- **Word-level soundbite timing** — [whisper](https://github.com/openai/whisper)
  transcribes with `--word_timestamps` so cuts land cleanly on word boundaries,
  never mid-syllable.
- **Animated overlays** — title cards, lower-thirds, captions, and CTAs are
  authored as animated SVGs with [domotion-svg](https://www.npmjs.com/package/domotion-svg)
  and rendered to transparent (alpha) video for compositing.
- **ffmpeg compositing** — segments are normalized to one spec, overlays are
  layered on, audio is synced for soundbites and silenced for B-roll, and the
  whole thing is concatenated into the final cut.
- **Frame-sampled verification** — the result is checked by sampling frames and
  re-transcribing soundbites, so a botched overlay or a clipped word gets caught.

The orchestration lives in a **Claude skill** ([`skills/video-studio/SKILL.md`](skills/video-studio/SKILL.md)).
Claude reads it and runs the pipeline step by step; you stay in the loop and
steer the creative decisions.

## Requirements

- **macOS** (it shells out to `ffmpeg`, `whisper`, and a headless browser, and
  the launcher uses Homebrew + the macOS GUI session for GPU work).
- **Node.js ≥ 18**.
- **[Claude Code](https://docs.claude.com/claude-code)** (`claude` on your PATH).
- `ffmpeg` / `ffprobe`, and `whisper` for soundbite timing. **Ollama is
  optional** — only needed if you want offline auto-descriptions instead of
  having Claude describe frames.

The launcher checks for all of these and offers to `brew install` the missing
ones, so you don't have to set them up by hand.

## Getting started

Run the launcher in the folder where your video lives:

```bash
npx video-studio .
```

It will:

1. Check the required tools and offer to install any that are missing.
2. Install dependencies and build the scene analyzer.
3. Install the `video-studio` Claude skill into `~/.claude/skills`.
4. Launch Claude Code in your working directory.

Then just tell Claude what you want:

> *"make a 15-second teaser from ~/Desktop/talk.mov"*

Other entry points:

```bash
npx video-studio --check        # doctor: report tool status, install nothing
npx video-studio --no-launch    # set everything up but don't start Claude
npx video-studio --skills-only  # (re)install just the Claude skill
npx video-studio --help
```

## When to use it

Reach for video-studio when you have **one long source** and want **short,
shareable cuts** out of it:

- A conference talk or webinar → a 15s teaser with a hook + CTA.
- A product demo → a vertical 9:16 reel for social.
- A raw screen recording → a tightened long edit with captions and title cards.

It's **not** a general-purpose NLE, and it's not built for multi-cam edits,
color grading, or audio mixing. It's for getting from "I have this long video"
to "here's a promo cut" with an AI doing the mechanical heavy lifting.

## How it's built

| Path | What it is |
|------|------------|
| [`skills/video-studio/SKILL.md`](skills/video-studio/SKILL.md) | The pipeline Claude follows — the primary interface. |
| [`bin/video-studio.mjs`](bin/video-studio.mjs) | The launcher: tool doctor, bootstrap, skill installer. |
| [`src/analyzer.ts`](src/analyzer.ts) → `dist/analyzer.js` | Resumable, frame-accurate scene detection (the `video-scene-analyzer` bin). |
| [`src/scene-math.ts`](src/scene-math.ts) | Pure fps / timecode / scene-merge math (unit-tested). |
| [`tools/render-caption.mjs`](tools/render-caption.mjs) | Caption / lower-third / CTA → animated SVG → alpha video. |
| [`tools/caption-format.mjs`](tools/caption-format.mjs) | Pure caption arg-parsing + SVG/HTML assembly (unit-tested). |
| [`docs/manual-test-plan.md`](docs/manual-test-plan.md) | Manual checklist for the external-tool pipeline. |

## Development

```bash
npm install
npm run build        # compile the TypeScript analyzer to dist/
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm test             # vitest unit tests + coverage
npm run check        # lint → typecheck → test → build (run before every change)
```

Tests cover the **pure, deterministic logic** (scene/timecode math, caption
assembly) to 100%. The ffmpeg/whisper/ollama/browser pipeline can't be unit
tested reliably — it's covered by [`docs/manual-test-plan.md`](docs/manual-test-plan.md).

## Releasing

```bash
npm run release        # interactive stable release (bumps version, updates
                       # CHANGELOG, tags, pushes; CI publishes to npm)
npm run release:beta   # tag-only beta off HEAD; CI publishes under `@beta`
```

Release notes are drafted with [gitgist](https://github.com/brianwestphal/gitgist).
See [`docs/releasing.md`](docs/releasing.md) for the full flow and the one-time
npm trusted-publisher setup.

## License

[MIT](LICENSE) © Brian Westphal

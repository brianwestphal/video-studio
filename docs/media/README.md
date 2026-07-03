# README demo media

Screenshots / GIFs / clips referenced by the top-level [`README.md`](../../README.md).

Generated from **Tears of Steel** — © Blender Foundation,
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), mango.blender.org.

**Docs-only — not shipped to npm.** `docs/` is not in `package.json` `files`, so
nothing here bloats the published package. The trade-off: npmjs.com renders the
README against the published tarball and won't find these relative paths, so the
images show only on GitHub. If you want them on npmjs.com too, switch the README
`<img src>` paths to absolute `https://raw.githubusercontent.com/brianwestphal/video-studio/main/docs/media/<file>`
URLs once the assets are committed.

The hero is a `<picture>`: an **animated WebP** primary with an animated **GIF**
fallback for renderers that can't do WebP.

```html
<picture>
  <source type="image/webp" srcset="docs/media/teaser-hero.webp">
  <img src="docs/media/teaser-hero.gif" alt="…" width="760">
</picture>
```

Browsers pick the WebP (small, full-color); anything that can't — including
markdown renderers that strip `<picture>` and fall through to the `<img>` — gets
the GIF. `scripts/gen-readme-media.sh` writes both: the WebP straight from
full-color frames via `img2webp` (single encode, ~5–7× smaller than the GIF), and
the GIF via an ffmpeg palette pass. Keep the WebP ≲ ~1–2 MB; the GIF is large by
nature (fallback only). Stills are ≲ ~760px wide to match the README layout.

## Expected assets

| File | Shows | Format |
|------|-------|--------|
| `teaser-hero.webp` | A finished ~9s teaser playing (hero, primary) | animated WebP, ~760px wide, ≲ 2 MB |
| `teaser-hero.gif` | The same teaser (hero fallback) | animated GIF, ~760px wide (large) |
| `scene-analysis.png` | A per-scene contact sheet (one frame per detected scene) | PNG, ~760px wide |
| `caption-overlay.png` | A caption / lower-third / CTA composited onto a frame | PNG, ~760px wide |
| `multicam-fcp.png` | A video-studio multicam `.fcpxml` open in FCP's angle viewer — several synced angles + master audio, mid angle-switch | PNG, ≤1280px wide, ≲ 600 KB |
| `multicam-fcp-timeline.png` | The same multicam `.fcpxml` as an FCP timeline — angle switches over the shared master audio | PNG, ≤1280px wide, ≲ 600 KB |

`multicam-fcp.png` + `multicam-fcp-timeline.png` are **captured and wired in** (VS-38,
from a real BYAM multi-cam sync → `export-multicam-fcpxml` → Final Cut Pro). The two
multicam stills cover the Final Cut Pro handoff for this release; a separate
`editor-handoff-fcp.png` (the `export-project` single-source cut with caption/overlay alpha
clips as connected clips) was considered and **dropped** as redundant (VS-38) — revisit if
a future release wants to showcase the overlay-compositing handoff specifically.

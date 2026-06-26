// Pure logic for multiple-source input (docs/multiple-sources.md): recognizing
// video files, deriving stable source ids, and assembling the combined sources
// manifest. No I/O here (folder walking + analysis live in analyze-sources.mjs),
// so this is all unit-tested.

export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mpg", ".mpeg"]);

export function isVideoFile(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 && VIDEO_EXTENSIONS.has(name.slice(i).toLowerCase());
}

// A short, filesystem-safe slug from a path's basename.
export function sourceSlug(p) {
  const base = p.split("/").pop().replace(/\.[^.]+$/, "");
  return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

// Assign every path a stable, unique id (slug, disambiguated as slug-2, slug-3…
// against ALL already-taken ids, so it stays unique even if a later path's slug
// collides with an earlier disambiguation).
export function assignSourceIds(paths) {
  const taken = new Set();
  return paths.map((path) => {
    const slug = sourceSlug(path);
    let id = slug;
    let n = 1;
    while (taken.has(id)) { n++; id = `${slug}-${n}`; }
    taken.add(id);
    return { path, id };
  });
}

// Build the combined sources manifest from per-source analysis results. Each
// `perSource` entry is { id, path, fps, durationSeconds, width, height, scenes }
// where `scenes` is that source's timeline (source-relative). The manifest lists
// every source plus the union of scenes, each tagged with its `sourceId`.
export function buildSourcesManifest(perSource) {
  return {
    sources: perSource.map((s) => ({
      id: s.id,
      path: s.path,
      fps: s.fps,
      durationSeconds: s.durationSeconds,
      width: s.width,
      height: s.height,
      sceneCount: (s.scenes || []).length,
    })),
    scenes: perSource.flatMap((s) => (s.scenes || []).map((sc) => ({ sourceId: s.id, ...sc }))),
  };
}

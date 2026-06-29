// Pure logic for PROPOSING multicam groups from the source pool
// (docs/multicam.md R-MC1, docs/multicam-sync.md). v1 of sync-multicam takes an
// explicit, user-labeled group; this helper suggests groups from source metadata
// so the skill can show them for confirmation. No I/O — the file stat / reading
// of sources.json lives in propose-groups.mjs, so this stays unit-tested.
//
// A "source" here is { id, path, durationSeconds?, startMs? } where startMs is a
// creation/recording timestamp in ms (from the file's birthtime). A proposed
// group is { id, reason, memberIds } with >=2 members.

// A filesystem-safe slug from an arbitrary label.
export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
}

function dropSingletons(map) {
  const groups = [];
  for (const [key, ids] of map) if (ids.length >= 2) groups.push({ key, memberIds: ids });
  return groups;
}

// Group sources by their containing folder (the path's directory). Clips dropped
// in one folder per shoot are a strong grouping signal.
export function groupByFolder(sources) {
  const byDir = new Map();
  for (const s of sources) {
    const dir = s.path.slice(0, Math.max(0, s.path.lastIndexOf("/")));
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(s.id);
  }
  return dropSingletons(byDir).map((g) => ({
    id: slug(g.key.slice(g.key.lastIndexOf("/") + 1) || "folder"),
    reason: "same folder",
    memberIds: g.memberIds,
  }));
}

// Group sources whose recording WINDOWS overlap (or sit within `gapSeconds` of
// each other). Each window is [startMs, startMs + durationSeconds*1000]; a sweep
// over sorted starts clusters anything that overlaps the running cluster end.
// Sources without a finite startMs are ignored (no timestamp to reason about).
export function groupByTimeWindow(sources, { gapSeconds = 60 } = {}) {
  const timed = sources
    .filter((s) => Number.isFinite(s.startMs))
    .map((s) => ({ id: s.id, start: s.startMs, end: s.startMs + (s.durationSeconds || 0) * 1000 }))
    .sort((a, b) => a.start - b.start);
  const gap = gapSeconds * 1000;
  const clusters = [];
  let current = null;
  for (const w of timed) {
    if (current && w.start <= current.end + gap) {
      current.ids.push(w.id);
      current.end = Math.max(current.end, w.end);
    } else {
      current = { ids: [w.id], end: w.end };
      clusters.push(current);
    }
  }
  return clusters
    .filter((c) => c.ids.length >= 2)
    .map((c, i) => ({ id: `event-${i + 1}`, reason: "overlapping recording windows", memberIds: c.ids }));
}

// Normalize a filename to an "event key" by stripping a trailing camera / angle /
// take token and sequence number, so e.g. `ceremony-cam1`, `ceremony-cam2`, and
// `ceremony-a` all collapse to `ceremony`. Heuristic; the user confirms.
export function eventKey(name) {
  const basename = name.slice(name.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "").toLowerCase();
  let base = basename;
  let prev;
  do {
    prev = base;
    base = base
      .replace(/[\s._-]*(cam(era)?|angle|ang|take)[\s._-]*\d*$/, "")
      .replace(/[\s._-]*\d+$/, "")
      .replace(/[\s._-]+[a-z]$/, "")
      .replace(/[\s._-]+$/, "");
  } while (base !== prev && base.length > 0);
  return base || basename;
}

// Group sources whose filenames share an event key (see eventKey).
export function groupByFilename(sources) {
  const byKey = new Map();
  for (const s of sources) {
    const key = eventKey(s.path);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s.id);
  }
  return dropSingletons(byKey).map((g) => ({ id: slug(g.key), reason: "shared filename pattern", memberIds: g.memberIds }));
}

// Propose multicam groups from the source pool. `strategy`:
//  - "time"     overlapping recording windows (needs startMs)
//  - "folder"   same containing folder
//  - "filename" shared filename pattern
//  - "auto"     (default) prefer time when any source is timestamped, else folder,
//               else filename — the first strategy that yields any group wins.
export function proposeGroups(sources, { strategy = "auto", gapSeconds = 60 } = {}) {
  if (strategy === "time") return groupByTimeWindow(sources, { gapSeconds });
  if (strategy === "folder") return groupByFolder(sources);
  if (strategy === "filename") return groupByFilename(sources);
  const ordered = sources.some((s) => Number.isFinite(s.startMs))
    ? [() => groupByTimeWindow(sources, { gapSeconds }), () => groupByFolder(sources), () => groupByFilename(sources)]
    : [() => groupByFolder(sources), () => groupByFilename(sources)];
  for (const run of ordered) {
    const groups = run();
    if (groups.length) return groups;
  }
  return [];
}

// Import-shape describer — the pure core of VS-100 / R-IM5 (docs/desktop-app-import.md §5).
//
// From an analyzed source pool (sources.json) it detects the project SHAPE — a single video,
// one multi-cam group, or several groups — and produces the human "detected shape" summary
// the New Project screen shows for confirmation ("4 angles, 3:59, multi-cam") BEFORE syncing.
// It reuses the tested grouping heuristics in tools/multicam-groups.mjs and does NO I/O — the
// host reads sources.json and, on the user's confirmation, runs sync-multicam per group.

import { proposeGroups } from "../../tools/multicam-groups.mjs";

// "M:SS" (or "H:MM:SS" past an hour) from a seconds count. Pure.
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${sec}`;
  return `${m}:${sec}`;
}

// The longest member duration in a group — angles are synced, so the group's runtime is the
// longest angle (a shorter angle just has less coverage). memberIds always come from the same
// pool that built `byId`, so the lookup is guaranteed; a source without a duration counts 0.
function groupDuration(byId, memberIds) {
  let max = 0;
  for (const id of memberIds) {
    const d = byId.get(id).durationSeconds || 0;
    if (d > max) max = d;
  }
  return max;
}

// Describe the import shape of an analyzed source pool. Returns
//   { shape, sourceCount, groups: [{ id, reason, memberIds, angleCount, durationSeconds, label }], summary }
// where `shape` is "single" (one video), "multicam" (one group), or "multi-group" (several).
// A pool of 2+ videos with no heuristic grouping collapses to one group ("all videos in the
// folder") so the user still gets one confirmable shape — the current sync-all behavior, now
// explicit. Throws when the pool is empty. Pure.
export function describeImportShape(sources) {
  const list = sources && Array.isArray(sources.sources) ? sources.sources : [];
  if (list.length === 0) throw new Error("no analyzed sources to group");

  if (list.length === 1) {
    return {
      shape: "single",
      sourceCount: 1,
      groups: [],
      summary: `1 video, ${formatDuration(list[0].durationSeconds)}, single-source`,
    };
  }

  const byId = new Map(list.map((s) => [s.id, s]));
  const proposed = proposeGroups(list);
  const raw = proposed.length
    ? proposed
    : [{ id: "group-1", reason: "all videos in the folder", memberIds: list.map((s) => s.id) }];

  const groups = raw.map((g) => {
    const durationSeconds = groupDuration(byId, g.memberIds);
    return {
      id: g.id,
      reason: g.reason,
      memberIds: g.memberIds,
      angleCount: g.memberIds.length,
      durationSeconds,
      label: `${g.memberIds.length} angles, ${formatDuration(durationSeconds)}`,
    };
  });

  if (groups.length > 1) {
    const total = groups.reduce((n, g) => n + g.angleCount, 0);
    return { shape: "multi-group", sourceCount: list.length, groups, summary: `${groups.length} groups (${total} videos), multi-cam` };
  }
  return {
    shape: "multicam",
    sourceCount: list.length,
    groups,
    summary: `${groups[0].angleCount} angles, ${formatDuration(groups[0].durationSeconds)}, multi-cam`,
  };
}

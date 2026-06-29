#!/usr/bin/env node
/**
 * propose-groups — suggest multicam groups from a source pool
 * (docs/multicam.md R-MC1). Reads a `sources.json` (from analyze-sources), pulls
 * each source's creation timestamp off disk, and prints proposed groups (>=2
 * clips that likely cover one event) plus a ready-to-run `sync-multicam` command
 * for each. The skill shows these for confirmation before syncing.
 *
 * Usage:
 *   propose-groups <sources.json> [--strategy <auto|time|folder|filename>] [--gap <sec>] [--json]
 *
 * The grouping heuristics (folder / overlapping recording windows / filename
 * pattern) are pure + unit-tested in ./multicam-groups.mjs; this is the I/O.
 */
import { readFileSync, statSync } from "node:fs";
import { proposeGroups } from "./multicam-groups.mjs";

function parseArgs(argv) {
  const opts = { sources: undefined, strategy: "auto", gapSeconds: 60, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strategy") opts.strategy = argv[++i];
    else if (a === "--gap") opts.gapSeconds = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") {
      console.log("Usage: propose-groups <sources.json> [--strategy <auto|time|folder|filename>] [--gap <sec>] [--json]");
      process.exit(0);
    } else if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(2); }
    else opts.sources = a;
  }
  if (!opts.sources) { console.error("Error: a sources.json path is required."); process.exit(2); }
  return opts;
}

// Best-effort creation timestamp: birthtime when the platform records it, else
// mtime. Missing files are skipped (no timestamp).
function startMsOf(path) {
  try {
    const st = statSync(path);
    return st.birthtimeMs || st.mtimeMs;
  } catch {
    return undefined;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(opts.sources, "utf8"));
  const sources = (manifest.sources || []).map((s) => ({
    id: s.id,
    path: s.path,
    durationSeconds: s.durationSeconds,
    startMs: startMsOf(s.path),
  }));

  const groups = proposeGroups(sources, { strategy: opts.strategy, gapSeconds: opts.gapSeconds });
  const byId = new Map(sources.map((s) => [s.id, s.path]));

  if (opts.json) { console.log(JSON.stringify({ groups }, null, 2)); return; }

  if (groups.length === 0) {
    console.log("No multicam groups proposed (need >=2 clips sharing a folder / overlapping time / filename pattern).");
    return;
  }
  console.log(`Proposed ${groups.length} multicam group(s):\n`);
  for (const g of groups) {
    console.log(`  ${g.id} — ${g.reason} (${g.memberIds.length} clips)`);
    for (const id of g.memberIds) console.log(`    - ${id}: ${byId.get(id)}`);
    const paths = g.memberIds.map((id) => `"${byId.get(id)}"`).join(" ");
    console.log(`    sync: sync-multicam ${paths} --group-id ${g.id}\n`);
  }
  console.log("Confirm or adjust these, then run the suggested sync-multicam command(s).");
}

main();

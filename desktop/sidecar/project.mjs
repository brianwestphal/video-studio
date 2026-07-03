// Project model (R-APP7–R-APP10, docs/desktop-app.md §3–§4) — the PURE core behind
// the stage rail. A Project is a folder of footage plus a per-project state file
// (.video-studio/project.json); the artifacts on disk are the source of truth, so
// stage state + the reconciled project are derived functions of a directory listing.
// host.mjs does the actual readdir/read/write (the I/O edge); everything here is
// side-effect-free and unit-tested to 100%.

// The per-project state file, relative to the project folder.
export const PROJECT_STATE_DIR = ".video-studio";
export const PROJECT_STATE_FILE = "project.json";

// Known pipeline artifacts (filenames in the project folder) and which each proves.
// `exports` is a directory; the rest are JSON files the tools write.
export const ARTIFACTS = Object.freeze({
  sources: "sources.json",
  multicam: "multicam.json",
  audioEvents: "audio-events.json",
  saliency: "saliency.json",
  switches: "switches.json",
  switchesHistory: "switches.history.json",
  cut: "cut.json", // single-source cut spec (export-project input)
  exports: "exports",
});

// The stage rail, in order. `requires` is the prior stage that must be `done`
// before this one unlocks (null = always reachable). `doneWhen` is a pure
// predicate over the set of present artifact keys.
export const STAGES = Object.freeze([
  { key: "setup", label: "Setup", requires: null, doneWhen: () => false },
  { key: "new-project", label: "New Project", requires: null, doneWhen: (a) => a.has("sources") || a.has("multicam") },
  { key: "analyze", label: "Analyze", requires: "new-project", doneWhen: (a) => a.has("audioEvents") },
  // Design produces a cut: switches.json (multi-cam) or cut.json (single-source).
  { key: "design", label: "Design", requires: "analyze", doneWhen: (a) => a.has("switches") || a.has("cut") },
  // Review: multi-cam records a history; a single-source cut needs no separate review pass.
  { key: "review", label: "Review", requires: "design", doneWhen: (a) => a.has("switchesHistory") || a.has("cut") },
  { key: "export", label: "Export", requires: "review", doneWhen: (a) => a.has("exports") },
]);

// Given a raw directory listing (filenames), return the set of present artifact
// *keys* (the ARTIFACTS keys whose filename appears). Pure.
export function presentArtifacts(fileNames) {
  const names = new Set(Array.isArray(fileNames) ? fileNames : []);
  const present = new Set();
  for (const [key, file] of Object.entries(ARTIFACTS)) {
    if (names.has(file)) present.add(key);
  }
  return present;
}

// Derive the stage rail state from the present artifacts + the user's selected
// stage. Each stage becomes { key, label, state } where state is:
//   "done"   — its artifact exists,
//   "locked" — a prerequisite stage is not done,
//   "active" — the selected stage (if reachable), else the first reachable
//              not-done stage,
//   "idle"   — reachable but neither active nor done.
// Pure over (artifact set, selected key). `setup` is always reachable.
export function deriveStages(artifacts, selectedKey = null) {
  const present = artifacts instanceof Set ? artifacts : presentArtifacts(artifacts);
  const doneByKey = new Map();
  const lockedByKey = new Map();
  for (const stage of STAGES) {
    const done = stage.doneWhen(present);
    const locked = stage.requires !== null && !doneByKey.get(stage.requires);
    doneByKey.set(stage.key, done);
    lockedByKey.set(stage.key, locked);
  }

  // The default active stage: the first reachable (unlocked) stage that isn't done.
  // `setup` is never `done` and never locked, so this always finds at least it.
  const firstActionable = STAGES.find((s) => !lockedByKey.get(s.key) && !doneByKey.get(s.key));
  const selectedReachable = selectedKey !== null && !lockedByKey.get(selectedKey);
  const activeKey = selectedReachable ? selectedKey : firstActionable.key;

  return STAGES.map((stage) => {
    let state;
    if (lockedByKey.get(stage.key)) state = "locked";
    else if (stage.key === activeKey) state = "active";
    else if (doneByKey.get(stage.key)) state = "done";
    else state = "idle";
    return { key: stage.key, label: stage.label, state };
  });
}

// A fresh project-state object for a new project. Pure.
export function newProjectState(name, sources = []) {
  return {
    name: String(name ?? "Untitled"),
    sources: Array.isArray(sources) ? [...sources] : [],
    artifacts: [],
  };
}

// Reconcile a saved project-state object against what's actually on disk. The
// filesystem is the source of truth (R-APP10): the returned `artifacts` list is
// re-derived from the directory listing, not trusted from the saved state, so a
// project stays valid even if a user added/deleted an artifact outside the app.
// A missing/corrupt saved state degrades to a minimal project named after the
// folder. Pure over (savedState, fileNames, folderName).
export function reconcileProject(savedState, fileNames, folderName = "Untitled") {
  const present = presentArtifacts(fileNames);
  const artifacts = [...present].sort();
  const base =
    savedState && typeof savedState === "object" && !Array.isArray(savedState)
      ? savedState
      : {};
  return {
    name: typeof base.name === "string" && base.name !== "" ? base.name : String(folderName),
    sources: Array.isArray(base.sources) ? base.sources : [],
    artifacts,
  };
}

// Pure decision for the launcher's analyzer-prep step (bin/video-studio.mjs, VS-77).
//
// The npm package ships a **prebuilt `dist/`** (see package.json `files`), so a user who
// `npx`/`npm i -g`s video-studio already has a working analyzer. Recompiling it needs the
// TypeScript toolchain — `typescript` + `@types/node` + `@types/fluent-ffmpeg` — which are
// **devDependencies** and npm does NOT install for consumers. The old launcher rebuilt
// unconditionally, so for every installed user `tsc` failed with a wall of "Cannot find
// name 'fs'/'process'/'NodeJS'" type errors even though the shipped `dist/` was fine.
//
// This decides what the launcher should actually do from three filesystem facts:
//   - hasDist        — dist/analyzer.js exists (shipped prebuilt, or built earlier)
//   - hasRuntimeDeps — runtime deps installed (node_modules/domotion-svg present)
//   - hasToolchain   — the TS build toolchain installed (node_modules/typescript present)
//
// Returns { npmInstall, build }:
//   - build — run `npm run build` (`tsc`) when there is no prebuilt analyzer (a fresh
//     source checkout — dist/ is gitignored) OR when the TS toolchain is installed (a dev
//     checkout, where rebuilding on launch keeps dist/ fresh). NEVER for an installed
//     consumer (prebuilt dist, no toolchain): that build needs devDependencies npm omits,
//     and fails with a wall of type errors (VS-77).
//   - npmInstall — run `npm install` when the runtime deps are missing, or a build is
//     required but the toolchain isn't present yet (a fresh checkout that must compile).
export function analyzerPrepPlan({ hasDist, hasRuntimeDeps, hasToolchain }) {
  const build = !hasDist || hasToolchain;
  const npmInstall = !hasRuntimeDeps || (build && !hasToolchain);
  return { npmInstall, build };
}

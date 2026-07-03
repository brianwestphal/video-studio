import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"],
    exclude: ["node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Coverage is enforced on the *pure, unit-testable* logic. The ffmpeg /
      // whisper / ollama / chromium orchestration (analyzer.ts, ffmpeg.ts,
      // ollama.ts, the launcher in bin/, render-caption.mjs) cannot be exercised
      // without those external tools — they are covered by docs/manual-test-plan.md.
      include: [
        "src/scene-math.ts",
        "src/resumable-error.ts",
        "src/analyzer-cli.ts",
        "src/analyzer-state.ts",
        "tools/caption-format.mjs",
        "tools/export-manifest.mjs",
        "tools/fcpxml.mjs",
        "tools/sources.mjs",
        "tools/multicam.mjs",
        "tools/multicam-dsp.mjs",
        "tools/multicam-groups.mjs",
        "tools/audio-events.mjs",
        "tools/wav-compat.mjs",
        "tools/transitions-render.mjs",
        "tools/visual-saliency.mjs",
        "tools/multicam-autocut.mjs",
        "tools/review-model.mjs",
        "tools/requirement-coverage.mjs",
        "tools/launcher-plan.mjs",
        "desktop/sidecar/protocol.mjs",
        "desktop/sidecar/steps.mjs",
        "desktop/sidecar/doctor.mjs",
        "desktop/sidecar/project.mjs",
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});

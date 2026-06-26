#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";

import { type Config, parseArgs } from "./analyzer-cli.js";
import { loadState, type PersistedState, saveState, stateMatchesVideo, STATE_VERSION } from "./analyzer-state.js";
import { detectSceneChanges, extractFrameAt, getVideoInfo } from "./ffmpeg.js";
import { analyzeFrame } from "./ollama.js";
import { classifyOllamaError, ResumableError } from "./resumable-error.js";
import { buildScenes, formatTimecode } from "./scene-math.js";

// Scene-detection tuning: ffmpeg `scene` score (0..1) a frame must exceed to
// count as a cut. Higher = fewer, more distinct scenes; 0.3-0.4 is a good range.
// (MIN_SCENE_SEC lives in scene-math.ts, alongside buildScenes which uses it.)
const SCENE_THRESHOLD = 0.4;

// Frame-accurate output record per scene.
interface SceneSegment {
  start: string; // HH:MM:SS:FF timecode
  end: string; // HH:MM:SS:FF timecode
  startFrame: number;
  endFrame: number;
  startSeconds: number;
  endSeconds: number;
  framePath: string; // representative frame for this scene (Claude can view it)
  description: string; // filled by Ollama if --describe ollama, else "" for Claude to fill
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function runAnalysis(config: Config): Promise<void> {
  const { videoPath, dataDir, model } = config;
  const framesDir = path.join(dataDir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });

  const stat = fs.statSync(videoPath);
  const resolvedVideoPath = path.resolve(videoPath);

  // --- Resume or initialize state -----------------------------------------
  let state: PersistedState | null = loadState(dataDir);
  if (state && !stateMatchesVideo(state, videoPath, stat)) {
    console.warn("Existing state is for a different video (or the file changed); starting fresh.");
    state = null;
  }

  // --- Step 1: scene boundaries (cached after first run) -------------------
  if (!state || state.scenes.length === 0) {
    console.log(`Detecting scene boundaries (threshold ${SCENE_THRESHOLD})...`);
    const [cutTimes, info] = await Promise.all([detectSceneChanges(videoPath, SCENE_THRESHOLD), getVideoInfo(videoPath)]);
    const totalFrames = Math.round(info.duration * info.fps);
    const scenes = buildScenes(cutTimes, totalFrames, info.fps);

    state = {
      version: STATE_VERSION,
      videoPath: resolvedVideoPath,
      videoSize: stat.size,
      videoMtimeMs: stat.mtimeMs,
      duration: info.duration,
      fps: info.fps,
      scenes,
      descriptions: state?.descriptions ?? {},
    };
    saveState(dataDir, state);
    console.log(`Detected ${scenes.length} scene(s) at ${info.fps}fps across ${formatTimecode(totalFrames, info.fps)}.`);
  } else {
    const done = Object.keys(state.descriptions).length;
    console.log(`Resuming: ${state.scenes.length} scene(s) already detected, ${done} already described.`);
  }

  const fps = state.fps;
  const framePathFor = (i: number) => path.join(framesDir, `scene-${String(i + 1).padStart(4, "0")}.jpg`);

  // --- Step 2: extract one representative frame per scene -------------------
  // By default descriptions are left blank for Claude to fill by viewing the
  // frames. With --describe ollama, fill them locally (resumable, incremental).
  const useOllama = config.describe === "ollama";
  console.log(useOllama ? "Extracting frames + describing scenes (Ollama)..." : "Extracting one representative frame per scene...");
  for (let i = 0; i < state.scenes.length; i++) {
    const scene = state.scenes[i]!;
    const framePath = framePathFor(i);
    if (!fs.existsSync(framePath)) {
      const midFrame = Math.floor((scene.startFrame + scene.endFrame) / 2);
      await extractFrameAt(videoPath, midFrame / fps, framePath);
    }

    if (useOllama && state.descriptions[i] === undefined) {
      console.log(`Scene ${i + 1}/${state.scenes.length} [${formatTimecode(scene.startFrame, fps)} - ${formatTimecode(scene.endFrame, fps)}]...`);
      let description: string;
      try {
        description = await analyzeFrame(framePath, "Describe this scene briefly. What is the setting and the main action occurring?", model);
      } catch (error) {
        throw classifyOllamaError(error, model); // resumable: re-run continues here
      }
      state.descriptions[i] = description;
      saveState(dataDir, state);
    }
  }

  // --- Step 3: assemble + emit the frame-accurate timeline ----------------
  const timeline: SceneSegment[] = state.scenes.map((scene, i) => ({
    start: formatTimecode(scene.startFrame, fps),
    end: formatTimecode(scene.endFrame, fps),
    startFrame: scene.startFrame,
    endFrame: scene.endFrame,
    startSeconds: scene.startFrame / fps,
    endSeconds: scene.endFrame / fps,
    framePath: path.resolve(framePathFor(i)),
    description: state.descriptions[i] ?? "",
  }));

  const json = JSON.stringify(timeline, null, 2);
  const timelinePath = path.join(dataDir, "timeline.json");
  fs.writeFileSync(timelinePath, json);
  if (config.out) {
    fs.mkdirSync(path.dirname(path.resolve(config.out)), { recursive: true });
    fs.writeFileSync(config.out, json);
  }

  console.log(`\n${timeline.length} scene(s) detected. Representative frames: ${framesDir}`);
  if (!useOllama) {
    console.log("Descriptions are blank by design — have Claude view each scene's `framePath` and fill them in.");
  }
  console.log(`Scenes JSON: ${timelinePath}${config.out ? ` and ${config.out}` : ""}`);
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  try {
    await runAnalysis(config);
  } catch (e) {
    if (e instanceof ResumableError) {
      console.error("\n========================================");
      console.error(`Stopped: ${e.message}`);
      console.error("----------------------------------------");
      console.error(e.instructions);
      console.error("----------------------------------------");
      console.error("Your progress so far is saved. Re-run the same command to continue.");
      console.error("========================================");
      process.exit(1);
    }
    console.error("An unexpected error occurred during video analysis:", e);
    console.error("Your progress so far is saved. Re-run the same command to continue.");
    process.exit(1);
  }
}

main();

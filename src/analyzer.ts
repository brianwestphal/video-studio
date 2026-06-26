#!/usr/bin/env node
import ffmpeg from "fluent-ffmpeg";
import ollama from "ollama";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { buildScenes, formatTimecode, parseFps, type Scene } from "./scene-math.js";

// Scene-detection tuning:
//  - SCENE_THRESHOLD: ffmpeg `scene` score (0..1) a frame must exceed to count as a cut.
//    Higher = fewer, more distinct scenes. 0.3-0.4 is a good starting range.
// (MIN_SCENE_SEC lives in scene-math.ts, alongside buildScenes which uses it.)
const SCENE_THRESHOLD = 0.4;

const DEFAULT_DATA_DIR = "./analysis-data";
const DEFAULT_MODEL = "gemma4:12b";
const STATE_VERSION = 2; // bumped: scenes are now frame-based

interface Config {
  videoPath: string;
  dataDir: string;
  model: string;
  describe: "none" | "ollama"; // "none" → Claude describes the extracted frames
  out?: string; // optional path to also write the scenes JSON
}

interface VideoInfo {
  duration: number; // seconds
  fps: number; // frames per second
}

// Everything we persist between runs so a re-run can resume instead of redoing work.
interface PersistedState {
  version: number;
  videoPath: string;
  videoSize: number;
  videoMtimeMs: number;
  duration: number; // seconds
  fps: number;
  scenes: Scene[]; // detected boundaries in frames (the expensive full-decode result)
  descriptions: Record<number, string>; // sceneIndex -> description (incremental progress)
}

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

// A failure we know how to explain and that is safely resumable on re-run.
class ResumableError extends Error {
  constructor(
    message: string,
    readonly instructions: string,
  ) {
    super(message);
    this.name = "ResumableError";
  }
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  node dist/analyzer.js <video-path> [data-dir] [--model <name>]",
      "",
      "Arguments:",
      "  <video-path>        Path to the video file to analyze (required).",
      `  [data-dir]          Folder for intermediate frames + resumable state.`,
      `                      Default: ${DEFAULT_DATA_DIR}`,
      "",
      "Options:",
      "      --describe <m>  Scene descriptions: 'none' (default; extract frames for",
      "                      Claude to describe) or 'ollama' (auto-describe locally).",
      `  -m, --model <name>  Ollama vision model (only with --describe ollama). Default: ${DEFAULT_MODEL}`,
      "  -o, --out <path>    Also write the frame-accurate scenes JSON to this path.",
      "  -h, --help          Show this help.",
      "",
      "By default this does frame-accurate scene detection + extracts one frame per",
      "scene; descriptions are left blank for Claude to fill by viewing the frames.",
      "Re-running the same command resumes from where it left off.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Config {
  const positionals: string[] = [];
  let model = DEFAULT_MODEL;
  let out: string | undefined;
  let describe: "none" | "ollama" = "none";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (arg === "--describe") {
      const value = argv[++i];
      if (value !== "none" && value !== "ollama") {
        console.error(`Error: --describe must be 'none' or 'ollama'.`);
        process.exit(2);
      }
      describe = value;
    } else if (arg.startsWith("--describe=")) {
      const value = arg.slice("--describe=".length);
      if (value !== "none" && value !== "ollama") {
        console.error(`Error: --describe must be 'none' or 'ollama'.`);
        process.exit(2);
      }
      describe = value;
    } else if (arg === "-m" || arg === "--model") {
      const value = argv[++i];
      if (!value) {
        console.error(`Error: ${arg} requires a model name.`);
        process.exit(2);
      }
      model = value;
    } else if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length);
    } else if (arg === "-o" || arg === "--out") {
      const value = argv[++i];
      if (!value) {
        console.error(`Error: ${arg} requires a path.`);
        process.exit(2);
      }
      out = value;
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg.startsWith("-")) {
      console.error(`Error: unknown option "${arg}".`);
      printUsage();
      process.exit(2);
    } else {
      positionals.push(arg);
    }
  }

  const videoPath = positionals[0];
  if (!videoPath) {
    console.error("Error: a video path is required.\n");
    printUsage();
    process.exit(2);
  }
  if (!fs.existsSync(videoPath)) {
    console.error(`Error: video file not found: ${videoPath}`);
    process.exit(2);
  }

  const dataDir = positionals[1] ?? DEFAULT_DATA_DIR;
  const config: Config = { videoPath, dataDir, model, describe };
  if (out !== undefined) config.out = out;
  return config;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function stateFilePath(dataDir: string): string {
  return path.join(dataDir, "state.json");
}

function loadState(dataDir: string): PersistedState | null {
  const file = stateFilePath(dataDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedState;
    if (parsed.version !== STATE_VERSION) return null;
    return parsed;
  } catch {
    console.warn(`Warning: could not read existing state at ${file}; starting fresh.`);
    return null;
  }
}

// Atomic write so an interruption mid-save can't corrupt the state file.
function saveState(dataDir: string, state: PersistedState): void {
  const file = stateFilePath(dataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

// A saved state is only reusable if it belongs to the same video file content.
function stateMatchesVideo(state: PersistedState, videoPath: string, stat: fs.Stats): boolean {
  return state.videoPath === path.resolve(videoPath) && state.videoSize === stat.size && state.videoMtimeMs === stat.mtimeMs;
}

// ---------------------------------------------------------------------------
// ffmpeg: duration probe + scene-boundary detection
// ---------------------------------------------------------------------------

// Probe duration (seconds) and frame rate — both needed for frame-accurate output.
function getVideoInfo(videoPath: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) return reject(err);
      const duration = data.format?.duration;
      if (typeof duration !== "number" || Number.isNaN(duration)) {
        return reject(new Error("Could not determine video duration."));
      }
      const vstream = data.streams?.find((s) => s.codec_type === "video");
      const fps = parseFps(vstream?.r_frame_rate) || parseFps(vstream?.avg_frame_rate);
      if (!fps || Number.isNaN(fps)) {
        return reject(new Error("Could not determine video frame rate."));
      }
      resolve({ duration, fps });
    });
  });
}

// Decode the video once, keep only frames whose `scene` score exceeds the threshold,
// and read their pts_time out of showinfo's log on stderr.
function detectSceneChanges(videoPath: string, threshold: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const args = ["-i", videoPath, "-filter:v", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-"];

    const proc = spawn("ffmpeg", args);
    let stderr = "";

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        return reject(
          new ResumableError(
            "ffmpeg is not installed or not on your PATH.",
            "Install ffmpeg (e.g. `brew install ffmpeg`) and run the same command again.",
          ),
        );
      }
      reject(err);
    });
    proc.on("close", (code) => {
      if (code !== 0 && stderr.trim() === "") {
        return reject(new Error(`ffmpeg scene detection exited with code ${code}`));
      }
      const times: number[] = [];
      const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(stderr)) !== null) {
        const t = parseFloat(match[1]!);
        if (!Number.isNaN(t)) times.push(t);
      }
      resolve(times);
    });
  });
}

function extractFrameAt(videoPath: string, timeSec: number, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(timeSec) // -ss before -i: fast input seek
      .frames(1)
      .outputOptions(["-vf", "scale=640:-1"])
      .output(outPath)
      .on("end", () => resolve(outPath))
      .on("error", (err) => reject(err))
      .run();
  });
}

// ---------------------------------------------------------------------------
// Ollama: describe a frame, with classified errors for the common failures
// ---------------------------------------------------------------------------

function classifyOllamaError(error: unknown, model: string): ResumableError {
  const err = error as { message?: string; status_code?: number; cause?: { code?: string } };
  const message = err?.message ?? String(error);
  const causeCode = err?.cause?.code;

  const connectionRefused = causeCode === "ECONNREFUSED" || /ECONNREFUSED|fetch failed|connect ECONNREFUSED|ECONNRESET/i.test(message);
  const modelMissing = err?.status_code === 404 || /not found|try pulling|no such model|model .*not found|pull the model/i.test(message);

  if (connectionRefused) {
    return new ResumableError(
      "Could not reach the Ollama server.",
      [
        "Ollama does not appear to be running. Start it, then re-run the same command:",
        "  • Open the Ollama app, or run `ollama serve` in another terminal.",
        "  • Verify it is up with: `ollama list`",
      ].join("\n"),
    );
  }
  if (modelMissing) {
    return new ResumableError(
      `The model "${model}" is not available in Ollama.`,
      ["Pull the model, then re-run the same command:", `  ollama pull ${model}`, "", "List installed models with: `ollama list`"].join(
        "\n",
      ),
    );
  }
  return new ResumableError(`Ollama request failed: ${message}`, "Resolve the issue above and re-run the same command to resume.");
}

async function analyzeFrame(imagePath: string, prompt: string, model: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");

  const response = await ollama.chat({
    model,
    messages: [
      {
        role: "user",
        content: prompt,
        images: [base64Image],
      },
    ],
  });

  return response.message.content.trim();
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
  let state = loadState(dataDir);
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
    description: state!.descriptions[i] ?? "",
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

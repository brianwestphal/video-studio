// CLI surface for the scene analyzer: argument parsing + usage text. Kept apart
// from the analysis I/O so the (process.exit/console-aside) parsing logic is
// unit-testable. `parseArgs` is the only boundary that touches the filesystem
// (an existence check on the video path).
import * as fs from "fs";

export const DEFAULT_DATA_DIR = "./analysis-data";
export const DEFAULT_MODEL = "gemma4:12b";

export interface Config {
  videoPath: string;
  dataDir: string;
  model: string;
  describe: "none" | "ollama"; // "none" → Claude describes the extracted frames
  out?: string; // optional path to also write the scenes JSON
}

export function printUsage(): void {
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

export function parseArgs(argv: string[]): Config {
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

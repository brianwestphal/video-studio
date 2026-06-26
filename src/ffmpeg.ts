// ffmpeg/ffprobe wrappers: duration+fps probe, scene-boundary detection, and
// single-frame extraction. This is genuinely I/O (spawns ffmpeg / shells out to
// ffprobe), so it's covered by the manual test plan rather than unit tests.
import { spawn } from "child_process";
import ffmpeg from "fluent-ffmpeg";

import { ResumableError } from "./resumable-error.js";
import { parseFps, videoFrameCount } from "./scene-math.js";

export interface VideoInfo {
  duration: number; // seconds (container)
  fps: number; // frames per second
  totalFrames: number; // decodable video frames (from the video stream, not the container)
}

// Probe duration (seconds), frame rate, and the real video-frame count — all
// needed for frame-accurate output. `totalFrames` comes from the video stream so
// a longer container (e.g. an audio tail) doesn't push boundaries past EOF.
export function getVideoInfo(videoPath: string): Promise<VideoInfo> {
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
      const totalFrames = videoFrameCount({
        nbFrames: vstream?.nb_frames,
        streamDuration: vstream?.duration,
        formatDuration: duration,
        fps,
      });
      resolve({ duration, fps, totalFrames });
    });
  });
}

// Decode the video once, keep only frames whose `scene` score exceeds the threshold,
// and read their pts_time out of showinfo's log on stderr.
export function detectSceneChanges(videoPath: string, threshold: number): Promise<number[]> {
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

export function extractFrameAt(videoPath: string, timeSec: number, outPath: string): Promise<string> {
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

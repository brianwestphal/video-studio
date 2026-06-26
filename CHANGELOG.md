# Changelog

All notable changes to **video-studio** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> ⚠️ **Early concept.** video-studio is an experiment. Interfaces, the skill, and the toolkit layout may change without notice while it's pre-1.0.

## [0.0.0] - 2026-06-26

- Initial public concept release.
- macOS toolkit + Claude skill for turning long videos into promo cuts: frame-accurate scene analysis (ffmpeg + Claude/Ollama vision), whisper word-level timing, domotion-svg title cards / captions / overlays, and ffmpeg compositing.
- `video-studio` launcher (`bin/video-studio.mjs`) — tool doctor, npm/build bootstrap, and Claude skill installer.
- `video-scene-analyzer` (`dist/analyzer.js`) — resumable, frame-accurate scene detection.
- `render-caption` tool for animated caption / lower-third / CTA overlays.

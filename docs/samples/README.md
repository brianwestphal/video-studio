# Reference samples

Real video-studio intermediates, kept because they show **how the AI reads the
footage** — the scene breakdown and the transcript are interesting artifacts in
their own right, not just throwaway scratch.

All of these are derived from **Tears of Steel** — © Blender Foundation,
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), mango.blender.org. The
README's demo media (`docs/media/`) comes from the same film.

| File | What it is |
|------|------------|
| [`tears-of-steel.scenes.json`](tears-of-steel.scenes.json) | A representative excerpt of the analyzer's scene breakdown (9 of 104 detected scenes): real frame-accurate boundaries + timecodes, with a **Claude-written description** of each scene (the default `--describe none` flow, where Claude views the extracted frame). |
| [`tears-of-steel.transcript.json`](tears-of-steel.transcript.json) | Whisper **word-level** transcription of the opening dialogue (~0:18–1:18), timestamps rebased to absolute video time. The shape the skill uses to cut soundbites on word boundaries. |
| [`tears-of-steel.transcript.txt`](tears-of-steel.transcript.txt) | The same transcript, human-readable and timecoded. |

These are **docs-only** — `docs/` is not in `package.json` `files`, so they
don't ship to npm; they're here for the README and for anyone curious about the
toolkit's output.

## Regenerating

- **Transcript:** `bash scripts/gen-readme-samples.sh` (needs `whisper`). Re-runs
  the word-level pass and rewrites the two transcript files.
- **Scene descriptions:** authored by Claude viewing the analyzer's frames, so
  there's no script — run the analyzer (`scripts/gen-readme-media.sh` extracts
  the frames) and have Claude describe them via the `video-studio` skill.

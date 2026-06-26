// Errors the analyzer knows how to explain and that are safe to resume from on a
// re-run (the persisted state means no work is lost). Pure — no I/O — so the
// error-classification branching is unit-testable.

// A failure we know how to explain and that is safely resumable on re-run.
export class ResumableError extends Error {
  constructor(
    message: string,
    readonly instructions: string,
  ) {
    super(message);
    this.name = "ResumableError";
  }
}

// Map an arbitrary Ollama failure onto a ResumableError with actionable, "fix it
// then re-run" instructions for the two common cases (server down / model not
// pulled), falling back to a generic resumable wrapper for anything else.
export function classifyOllamaError(error: unknown, model: string): ResumableError {
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

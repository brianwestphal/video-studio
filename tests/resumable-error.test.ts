import { describe, expect, it } from "vitest";

import { classifyOllamaError, ResumableError } from "../src/resumable-error.js";

describe("ResumableError", () => {
  it("carries a message and resumable instructions", () => {
    const e = new ResumableError("something broke", "do X then re-run");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ResumableError");
    expect(e.message).toBe("something broke");
    expect(e.instructions).toBe("do X then re-run");
  });
});

describe("classifyOllamaError", () => {
  it("detects a refused connection via cause.code", () => {
    const e = classifyOllamaError({ cause: { code: "ECONNREFUSED" } }, "m");
    expect(e.message).toMatch(/Could not reach the Ollama server/);
    expect(e.instructions).toMatch(/ollama serve/);
  });

  it("detects a refused connection via the message text", () => {
    const e = classifyOllamaError({ message: "fetch failed" }, "m");
    expect(e.message).toMatch(/Could not reach the Ollama server/);
  });

  it("detects ECONNRESET in the message as a connection problem", () => {
    const e = classifyOllamaError({ message: "read ECONNRESET" }, "m");
    expect(e.message).toMatch(/Could not reach the Ollama server/);
  });

  it("detects a missing model via status_code 404", () => {
    const e = classifyOllamaError({ status_code: 404 }, "gemma4:12b");
    expect(e.message).toMatch(/The model "gemma4:12b" is not available/);
    expect(e.instructions).toMatch(/ollama pull gemma4:12b/);
  });

  it("detects a missing model via the message text", () => {
    const e = classifyOllamaError({ message: "model 'x' not found, try pulling it" }, "x");
    expect(e.message).toMatch(/is not available/);
  });

  it("falls back to a generic resumable error with the message", () => {
    const e = classifyOllamaError({ message: "weird internal failure" }, "m");
    expect(e.message).toBe("Ollama request failed: weird internal failure");
    expect(e.instructions).toMatch(/re-run the same command/);
  });

  it("stringifies a non-object error for the generic fallback", () => {
    const e = classifyOllamaError("boom", "m");
    expect(e.message).toBe("Ollama request failed: boom");
  });

  it("prioritizes connection-refused over a coincidental 404 in the same error", () => {
    const e = classifyOllamaError({ status_code: 404, cause: { code: "ECONNREFUSED" } }, "m");
    expect(e.message).toMatch(/Could not reach the Ollama server/);
  });
});

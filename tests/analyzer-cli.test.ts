import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DATA_DIR, DEFAULT_MODEL, parseArgs } from "../src/analyzer-cli.js";

// A real on-disk file so parseArgs's existence check passes on the happy paths.
let VIDEO: string;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "vs-cli-"));
  VIDEO = join(dir, "clip.mov");
  writeFileSync(VIDEO, "x");
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("parseArgs — happy paths", () => {
  it("fills defaults from just a video path", () => {
    expect(parseArgs([VIDEO])).toEqual({
      videoPath: VIDEO,
      dataDir: DEFAULT_DATA_DIR,
      model: DEFAULT_MODEL,
      describe: "none",
    });
  });

  it("takes a data-dir positional", () => {
    expect(parseArgs([VIDEO, "/data"]).dataDir).toBe("/data");
  });

  it("parses --describe ollama and --describe=ollama", () => {
    expect(parseArgs([VIDEO, "--describe", "ollama"]).describe).toBe("ollama");
    expect(parseArgs([VIDEO, "--describe=ollama"]).describe).toBe("ollama");
  });

  it("parses --describe none explicitly", () => {
    expect(parseArgs([VIDEO, "--describe", "none"]).describe).toBe("none");
  });

  it("parses -m / --model / --model=", () => {
    expect(parseArgs([VIDEO, "-m", "llava"]).model).toBe("llava");
    expect(parseArgs([VIDEO, "--model", "llava"]).model).toBe("llava");
    expect(parseArgs([VIDEO, "--model=llava"]).model).toBe("llava");
  });

  it("parses -o / --out / --out=", () => {
    expect(parseArgs([VIDEO, "-o", "a.json"]).out).toBe("a.json");
    expect(parseArgs([VIDEO, "--out", "b.json"]).out).toBe("b.json");
    expect(parseArgs([VIDEO, "--out=c.json"]).out).toBe("c.json");
  });

  it("omits `out` when --out is not given", () => {
    expect("out" in parseArgs([VIDEO])).toBe(false);
  });
});

describe("parseArgs — exits", () => {
  it("prints help and exits 0 on -h/--help", () => {
    expect(() => parseArgs(["--help"])).toThrow("exit:0");
    expect(() => parseArgs(["-h"])).toThrow("exit:0");
  });

  it("exits 2 on an invalid --describe value", () => {
    expect(() => parseArgs([VIDEO, "--describe", "maybe"])).toThrow("exit:2");
  });

  it("exits 2 on an invalid --describe= value", () => {
    expect(() => parseArgs([VIDEO, "--describe=maybe"])).toThrow("exit:2");
  });

  it("exits 2 when --model has no value", () => {
    expect(() => parseArgs([VIDEO, "--model"])).toThrow("exit:2");
  });

  it("exits 2 when --out has no value", () => {
    expect(() => parseArgs([VIDEO, "--out"])).toThrow("exit:2");
  });

  it("exits 2 on an unknown flag", () => {
    expect(() => parseArgs([VIDEO, "--bogus"])).toThrow("exit:2");
  });

  it("exits 2 when no video path is given", () => {
    expect(() => parseArgs([])).toThrow("exit:2");
  });

  it("exits 2 when the video path does not exist", () => {
    expect(() => parseArgs(["/no/such/file.mov"])).toThrow("exit:2");
  });
});

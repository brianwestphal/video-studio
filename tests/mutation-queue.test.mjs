import { describe, it, expect } from "vitest";
import {
  MUTATING_STEPS,
  isMutatingStep,
  createMutationQueue,
} from "../desktop/sidecar/mutation-queue.mjs";

describe("mutation-queue — isMutatingStep", () => {
  it("classifies the mutating steps and nothing else", () => {
    for (const s of MUTATING_STEPS) expect(isMutatingStep(s)).toBe(true);
    for (const s of ["project-open", "project-create", "config-get", "review-start", "agent-run", "nope"]) {
      expect(isMutatingStep(s)).toBe(false);
    }
  });
  it("MUTATING_STEPS is frozen data", () => {
    expect(Object.isFrozen(MUTATING_STEPS)).toBe(true);
    expect(MUTATING_STEPS).toContain("export-fcpxml");
  });
});

describe("mutation-queue — single project serialization", () => {
  it("first job runs, the rest queue FIFO", () => {
    const q = createMutationQueue();
    expect(q.enqueue("a1", "/proj")).toBe("run");
    expect(q.enqueue("a2", "/proj")).toBe("queued");
    expect(q.enqueue("a3", "/proj")).toBe("queued");
    expect(q.isRunning("/proj")).toBe(true);
    expect(q.pending("/proj")).toEqual(["a2", "a3"]);
  });

  it("finishing the runner promotes the next in FIFO order", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.enqueue("a2", "/proj");
    q.enqueue("a3", "/proj");
    expect(q.finish("a1")).toEqual({ started: "a2" });
    expect(q.pending("/proj")).toEqual(["a3"]);
    expect(q.finish("a2")).toEqual({ started: "a3" });
    expect(q.pending("/proj")).toEqual([]);
    expect(q.finish("a3")).toEqual({ started: null });
    expect(q.isRunning("/proj")).toBe(false);
  });

  it("re-enqueue after the queue drains starts running again (empty-then-refill)", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.finish("a1");
    expect(q.isRunning("/proj")).toBe(false);
    expect(q.enqueue("a2", "/proj")).toBe("run");
    expect(q.isRunning("/proj")).toBe(true);
  });
});

describe("mutation-queue — concurrent across projects", () => {
  it("different projects run independently and concurrently", () => {
    const q = createMutationQueue();
    expect(q.enqueue("a1", "/p1")).toBe("run");
    expect(q.enqueue("b1", "/p2")).toBe("run");
    expect(q.enqueue("a2", "/p1")).toBe("queued");
    expect(q.enqueue("b2", "/p2")).toBe("queued");
    expect(q.finish("a1")).toEqual({ started: "a2" });
    expect(q.isRunning("/p2")).toBe(true); // p2 untouched
    expect(q.finish("b1")).toEqual({ started: "b2" });
  });
});

describe("mutation-queue — cancellation", () => {
  it("cancelling the running job advances to the next", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.enqueue("a2", "/proj");
    expect(q.cancel("a1")).toEqual({ wasRunning: true, started: "a2" });
    expect(q.isRunning("/proj")).toBe(true);
    expect(q.pending("/proj")).toEqual([]);
  });

  it("cancelling the running job with nothing queued clears the project", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    expect(q.cancel("a1")).toEqual({ wasRunning: true, started: null });
    expect(q.isRunning("/proj")).toBe(false);
  });

  it("cancelling a queued job just drops it, keeping order", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.enqueue("a2", "/proj");
    q.enqueue("a3", "/proj");
    expect(q.cancel("a2")).toEqual({ wasRunning: false, started: null });
    expect(q.pending("/proj")).toEqual(["a3"]);
    expect(q.finish("a1")).toEqual({ started: "a3" });
  });

  it("cancelling the only queued job removes the empty waiting list", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.enqueue("a2", "/proj");
    q.cancel("a2");
    expect(q.pending("/proj")).toEqual([]);
    expect(q.finish("a1")).toEqual({ started: null });
  });

  it("a cancelled id can be re-enqueued (id is released)", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.cancel("a1");
    expect(() => q.enqueue("a1", "/proj")).not.toThrow();
    expect(q.enqueue("a1b", "/proj")).toBe("queued");
  });
});

describe("mutation-queue — adversarial / unknown ids", () => {
  it("duplicate live id throws", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    expect(() => q.enqueue("a1", "/proj")).toThrow(/duplicate job id/);
    expect(() => q.enqueue("a1", "/other")).toThrow(/duplicate job id/);
  });

  it("finish/cancel of an unknown id is a harmless no-op", () => {
    const q = createMutationQueue();
    expect(q.finish("ghost")).toEqual({ started: null });
    expect(q.cancel("ghost")).toEqual({ wasRunning: false, started: null });
  });

  it("finishing a still-queued job (defensive) drops it without promoting", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.enqueue("a2", "/proj");
    q.enqueue("a3", "/proj");
    // a2 never ran, but a stray finish for it should just remove it, leaving a1 running.
    expect(q.finish("a2")).toEqual({ started: null });
    expect(q.isRunning("/proj")).toBe(true);
    expect(q.pending("/proj")).toEqual(["a3"]);
    expect(q.finish("a1")).toEqual({ started: "a3" });
  });

  it("finishing a job twice does not double-promote", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/proj");
    q.enqueue("a2", "/proj");
    expect(q.finish("a1")).toEqual({ started: "a2" });
    expect(q.finish("a1")).toEqual({ started: null }); // already gone
    expect(q.pending("/proj")).toEqual([]);
  });

  it("interleaved multi-project cancel + finish keeps each project's FIFO intact", () => {
    const q = createMutationQueue();
    q.enqueue("a1", "/p1");
    q.enqueue("a2", "/p1");
    q.enqueue("a3", "/p1");
    q.enqueue("b1", "/p2");
    q.cancel("a2"); // drop middle of p1
    q.cancel("b1"); // cancel p2's runner, nothing queued
    expect(q.isRunning("/p2")).toBe(false);
    expect(q.finish("a1")).toEqual({ started: "a3" });
    expect(q.finish("a3")).toEqual({ started: null });
    expect(q.isRunning("/p1")).toBe(false);
  });
});

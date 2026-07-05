// Per-project mutation serializer — the pure core of R-APP14 (desktop-app.md §5).
//
// Two mutating steps on the SAME project folder (import, analyze, design, export) must not
// run at once — they write the same artifacts and would race. Different projects, however,
// should run concurrently. This module is that scheduler's pure logic: it tracks which job
// is running per project and a FIFO of jobs waiting behind it, and it tells the host when a
// job may start and which queued job to start next when one finishes or is cancelled. It
// does NO I/O and owns NO timers/child processes — the host spawns, kills, and calls back
// here on each lifecycle edge. Unit-tested to 100% (the state machine is the whole point).

// The steps that MUTATE a project's artifacts and so must be serialized per project.
// Read-only / long-lived steps (project-open, config-*, review-*, agent-run) are NOT queued.
export const MUTATING_STEPS = Object.freeze([
  "import-footage",
  "analyze-project",
  "design-cut",
  "export-mp4",
  "export-social",
  "export-fcpxml",
]);

const MUTATING_SET = new Set(MUTATING_STEPS);

// Whether a step name mutates a project (and therefore goes through the queue). Pure.
export function isMutatingStep(step) {
  return MUTATING_SET.has(step);
}

// Create a fresh per-project serializer. Jobs are identified by a caller-chosen `id`
// (the request id) and a `project` key (the folder path). All methods are synchronous and
// side-effect-free beyond the queue's own internal state.
export function createMutationQueue() {
  const running = new Map(); // project -> the job id currently running
  const waiting = new Map(); // project -> [job id, ...] FIFO waiting behind the running one
  const jobProject = new Map(); // job id -> project (so cancel/finish can look up by id)

  // Remove a queued (not running) job from its project's waiting list. Only ever called for a
  // job known to be queued, so the list is guaranteed to exist and contain it.
  function dropWaiting(project, id) {
    const q = waiting.get(project);
    q.splice(q.indexOf(id), 1);
    if (q.length === 0) waiting.delete(project);
  }

  // Promote the next queued job for `project` to running and return its id, or null when the
  // queue for that project is empty. Assumes the previous runner has already been cleared.
  function promoteNext(project) {
    const q = waiting.get(project);
    if (q && q.length > 0) {
      const next = q.shift();
      if (q.length === 0) waiting.delete(project);
      running.set(project, next);
      return next;
    }
    return null;
  }

  // Register a new job. Returns "run" when it may start immediately (nothing else is running
  // for that project) or "queued" when it must wait. Throws on a duplicate id so a caller
  // bug surfaces loudly rather than corrupting the queue.
  function enqueue(id, project) {
    if (jobProject.has(id)) throw new Error(`duplicate job id: ${id}`);
    jobProject.set(id, project);
    if (!running.has(project)) {
      running.set(project, id);
      return "run";
    }
    if (!waiting.has(project)) waiting.set(project, []);
    waiting.get(project).push(id);
    return "queued";
  }

  // A job finished (its process exited). Returns { started } where `started` is the id of the
  // next job the host should now spawn for that project, or null. A finish for an unknown id,
  // or for a job that was only queued, is a harmless no-op ({ started: null }).
  function finish(id) {
    const project = jobProject.get(id);
    if (project === undefined) return { started: null };
    jobProject.delete(id);
    if (running.get(project) === id) {
      running.delete(project);
      return { started: promoteNext(project) };
    }
    dropWaiting(project, id);
    return { started: null };
  }

  // Cancel a job by id. Returns { wasRunning, started }: when it was the running job the host
  // must kill its child and start `started` next; when it was only queued it is simply
  // dropped (wasRunning false, started null). Unknown id → both falsy.
  function cancel(id) {
    const project = jobProject.get(id);
    if (project === undefined) return { wasRunning: false, started: null };
    jobProject.delete(id);
    if (running.get(project) === id) {
      running.delete(project);
      return { wasRunning: true, started: promoteNext(project) };
    }
    dropWaiting(project, id);
    return { wasRunning: false, started: null };
  }

  // Whether a job is currently running for `project`. Pure read.
  function isRunning(project) {
    return running.has(project);
  }

  // The ids waiting behind the running job for `project` (a copy, FIFO order). Pure read.
  function pending(project) {
    const q = waiting.get(project);
    return q ? q.slice() : [];
  }

  return { enqueue, finish, cancel, isRunning, pending };
}

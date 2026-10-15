/**
 * Framework-free coordinator for thread REST loads. It guarantees:
 * - at most one load in flight per active thread;
 * - a reload requested during a load runs exactly one more load after it;
 * - a response for a thread that is no longer active is never applied.
 */

export interface ReloaderDeps<T> {
  fetch: (threadId: string) => Promise<T>;
  apply: (threadId: string, value: T) => void;
  fail: (threadId: string, error: unknown) => void;
}

export interface Reloader {
  /** Makes threadId the active thread and resets in-flight/rerun bookkeeping. */
  activate(threadId: string): void;
  /** Stops applying responses and drops any queued rerun. */
  deactivate(): void;
  /** Loads threadId now, or queues one rerun if a load is already in flight. */
  reload(threadId: string): void;
}

export function createReloader<T>(deps: ReloaderDeps<T>): Reloader {
  let activeId: string | null = null;
  let generation = 0;
  let inFlight = false;
  let rerun = false;

  async function run(threadId: string): Promise<void> {
    const gen = generation;
    inFlight = true;
    try {
      const value = await deps.fetch(threadId);
      if (gen === generation && threadId === activeId)
        deps.apply(threadId, value);
    } catch (error) {
      if (gen === generation && threadId === activeId)
        deps.fail(threadId, error);
    } finally {
      if (gen === generation) {
        inFlight = false;
        if (rerun && activeId !== null) {
          rerun = false;
          void run(activeId);
        }
      }
    }
  }

  return {
    activate(threadId) {
      activeId = threadId;
      generation += 1;
      inFlight = false;
      rerun = false;
    },
    deactivate() {
      activeId = null;
      generation += 1;
      inFlight = false;
      rerun = false;
    },
    reload(threadId) {
      if (threadId !== activeId) return;
      if (inFlight) {
        rerun = true;
        return;
      }
      void run(threadId);
    },
  };
}

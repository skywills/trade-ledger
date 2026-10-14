import { cancelActiveAnalyses, drainActiveAnalyses } from "../ai/analysis.js";
import { cancelActiveBuilds, drainActiveBuilds } from "../builds/service.js";
import type { Store } from "../storage/database.js";

export interface ShutdownOptions {
  readonly cancelAnalyses?: () => void;
  readonly drainAnalyses?: () => Promise<void>;
  readonly cancelBuilds?: () => void;
  readonly drainBuilds?: () => Promise<void>;
}

/**
 * Graceful termination. Cancels in-flight AI analysis through each run's
 * session, aborts every in-flight rebuild so a candidate observed mid-flight is
 * cancelled before it can be activated, then awaits both until settled. The
 * writer queue is drained, but the active build pointer is never touched, so a
 * partial generation can never become active. The store stays open; the caller
 * closes the app (and its store) afterwards.
 */
export async function shutdown(
  store: Store,
  options: ShutdownOptions = {},
): Promise<void> {
  // Cancellation is driven through the process-wide registries so detached
  // work is stopped directly; no external signal is threaded through.
  const cancelAnalyses = options.cancelAnalyses ?? cancelActiveAnalyses;
  const drainAnalyses = options.drainAnalyses ?? drainActiveAnalyses;
  const cancelBuilds = options.cancelBuilds ?? cancelActiveBuilds;
  const drainBuilds = options.drainBuilds ?? drainActiveBuilds;

  cancelAnalyses();
  cancelBuilds();

  await Promise.all([drainAnalyses(), drainBuilds()]);
  await store.queue.drain();
}

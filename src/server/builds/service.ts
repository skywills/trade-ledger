import { randomUUID } from "node:crypto";
import type {
  BuildResult,
  Id,
  LedgerSnapshot,
  Projection,
  Strategy,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import {
  type StrategyAnchor,
  strategyAnchorKey,
  strategyId,
} from "../decisions/registry.js";
import { effectiveDecisions, readDecisions } from "../decisions/service.js";
import { JobService } from "../jobs/service.js";
import {
  LEDGER_PARSER_VERSION,
  normalizeLedger,
  readLedger,
} from "../ledger/normalize.js";
import type { Store } from "../storage/database.js";
import { loadLedgerSnapshot } from "../storage/ledger.js";
import {
  accountProjection,
  validateProjection,
} from "../strategies/accounting.js";
import { groupStrategies } from "../strategies/grouping.js";
import {
  activateIfCurrent,
  failInterruptedBuilds,
  insertCandidate,
  loadProjection,
  markBuildStatus,
  persistProjection,
  readActiveBuild,
  readBuild,
  switchActiveBuild,
} from "./repository.js";
import {
  activeLedgerBuild,
  inputsChanged,
  snapshotInputs,
} from "./snapshot.js";

export const ALGORITHM_VERSION = "strategies-v1";

/**
 * Process-wide registry of in-flight rebuilds. Graceful shutdown aborts these
 * controllers so a build observed mid-flight is cancelled before it can
 * activate, then awaits them so the store is never closed mid-write.
 */
const BUILD_CONTROLLERS = new Set<AbortController>();
const IN_FLIGHT_BUILDS = new Set<Promise<unknown>>();

/** Aborts every in-flight rebuild without activating a partial generation. */
export function cancelActiveBuilds(): void {
  for (const controller of [...BUILD_CONTROLLERS]) controller.abort();
}

/** Waits for every in-flight rebuild to settle. */
export async function drainActiveBuilds(): Promise<void> {
  await Promise.allSettled([...IN_FLIGHT_BUILDS]);
}

export interface RebuildInput {
  mode: "full" | "projection";
  parserVersion: string;
  algorithmVersion: string;
  signal: AbortSignal;
}

export interface BuildFaults {
  /** Runs after the candidate is computed but before the activation switch. */
  afterCompute?: () => Promise<void> | void;
}

export interface BuildServiceOptions {
  faults?: BuildFaults;
  now?: () => Date;
}

export interface ActiveProjection {
  buildId: Id | null;
  stale: boolean;
  projection: Projection | null;
}

function functionNow(options: BuildServiceOptions): () => Date {
  return options.now ?? (() => new Date());
}

/**
 * Replaces provisional anchor-key ids produced by the pure grouping pass with
 * the durable strategy identities resolved from the retained registry. Applied
 * before accounting so issue keys and apportionment ordering use durable ids.
 */
export function remapStrategyIds(
  projection: Projection,
  remap: ReadonlyMap<Id, Id>,
): Projection {
  const idOf = (id: Id): Id => remap.get(id) ?? id;
  return {
    ...projection,
    strategies: projection.strategies.map(
      (strategy): Strategy => ({ ...strategy, id: idOf(strategy.id) }),
    ),
    allocations: projection.allocations.map((allocation) => ({
      ...allocation,
      strategyId: idOf(allocation.strategyId),
    })),
    links: projection.links.map((link) => ({
      ...link,
      from: idOf(link.from),
      to: idOf(link.to),
    })),
  };
}

/**
 * Computes a full projection for one ledger at a watermark: pure grouping with
 * a provisional anchor resolver, durable strategy identity resolution, then
 * accounting. Deterministic and store-independent apart from identity lookups.
 */
export async function computeProjection(
  store: Store,
  ledger: LedgerSnapshot,
  watermark: number,
): Promise<Projection> {
  const decisions = effectiveDecisions(readDecisions(store, watermark));
  const anchors = new Map<string, StrategyAnchor>();
  const resolveId = (account: string, keys: string[]): Id => {
    const key = strategyAnchorKey({ account, openingKeys: keys });
    anchors.set(key, { account, openingKeys: [...keys] });
    return key;
  };
  const provisional = groupStrategies(ledger, decisions, resolveId);
  const remap = new Map<Id, Id>();
  for (const [key, anchor] of anchors) {
    remap.set(key, await strategyId(store, anchor));
  }
  return accountProjection(ledger, remapStrategyIds(provisional, remap));
}

function readRetainedLedger(
  store: Store,
  parserVersion: string,
): LedgerSnapshot {
  const retained = activeLedgerBuild(store.db);
  if (retained === null) {
    throw new AppError(
      "VERSION_UNAVAILABLE",
      "No retained ledger generation is available for a projection rebuild.",
      400,
    );
  }
  if (retained.parserVersion !== parserVersion) {
    throw new AppError(
      "VERSION_UNAVAILABLE",
      `The retained ledger generation uses parser version ${retained.parserVersion}, not ${parserVersion}.`,
      400,
    );
  }
  return readLedger(store, retained.id);
}

/**
 * Builds a new generation. The ledger is re-normalized (full) or reused from
 * the active generation (projection); grouping and accounting run outside the
 * writer queue. The candidate is persisted, validated outside any transaction,
 * and only then activated. Activation is a single serialized compare-and-switch
 * that refuses to move the active pointer when a decision or import landed
 * during the build. Hard invariant failures, cancellations, and stale
 * candidates are never activated, and interrupted candidates are failed.
 */
export async function rebuild(
  store: Store,
  input: RebuildInput,
  options: BuildServiceOptions = {},
): Promise<BuildResult> {
  const now = functionNow(options);
  if (input.parserVersion !== LEDGER_PARSER_VERSION) {
    throw new AppError(
      "VERSION_UNAVAILABLE",
      `Ledger parser version ${input.parserVersion} is unavailable; this build implements ${LEDGER_PARSER_VERSION}.`,
      400,
    );
  }
  if (input.algorithmVersion !== ALGORITHM_VERSION) {
    throw new AppError(
      "VERSION_UNAVAILABLE",
      `Strategy algorithm version ${input.algorithmVersion} is unavailable; this build implements ${ALGORITHM_VERSION}.`,
      400,
    );
  }
  if (input.signal.aborted) {
    return { id: randomUUID(), status: "cancelled", issues: [] };
  }

  const snapshot = snapshotInputs(store, input.parserVersion);
  const ledger =
    input.mode === "full"
      ? await normalizeLedger(store, {
          parserVersion: input.parserVersion,
          decisionWatermark: snapshot.watermark,
        })
      : readRetainedLedger(store, input.parserVersion);

  if (input.signal.aborted) {
    return { id: randomUUID(), status: "cancelled", issues: [] };
  }

  const buildId = await insertCandidate(store, {
    ledgerId: ledger.id,
    watermark: snapshot.watermark,
    algorithmVersion: input.algorithmVersion,
    inputHash: snapshot.hash,
    now: now().toISOString(),
  });

  const projection = await computeProjection(store, ledger, snapshot.watermark);
  await persistProjection(
    store,
    buildId,
    ledger.id,
    projection,
    now().toISOString(),
  );

  const validation = validateProjection(ledger, projection);
  const hasHardFailure = validation.some((issue) => issue.severity === "error");

  if (input.signal.aborted) {
    await markBuildStatus(
      store,
      buildId,
      "cancelled",
      validation,
      now().toISOString(),
    );
    return { id: buildId, status: "cancelled", issues: validation };
  }
  if (hasHardFailure) {
    await markBuildStatus(
      store,
      buildId,
      "failed",
      validation,
      now().toISOString(),
    );
    return { id: buildId, status: "failed", issues: validation };
  }

  await options.faults?.afterCompute?.();

  if (input.signal.aborted) {
    await markBuildStatus(
      store,
      buildId,
      "cancelled",
      validation,
      now().toISOString(),
    );
    return { id: buildId, status: "cancelled", issues: validation };
  }

  const activation = await activateIfCurrent(
    store,
    buildId,
    input.parserVersion,
    validation,
    now().toISOString(),
  );
  return { id: buildId, status: activation.status, issues: validation };
}

/**
 * Reads the active build's reconstructed projection and reports staleness by
 * comparing its recorded input hash and watermark against the current imports
 * and decisions. The projection is read from retained tables, never recomputed.
 */
export function activeProjection(store: Store): ActiveProjection {
  const build = readActiveBuild(store.db);
  if (build === null) {
    return { buildId: null, stale: false, projection: null };
  }
  return {
    buildId: build.id,
    stale: inputsChanged(store, build),
    projection: loadProjection(store.db, build.id),
  };
}

/**
 * Lightweight active-build identity for list envelopes. Unlike
 * `activeProjection`, this never reconstructs the projection, so read-only
 * listing endpoints stay cheap.
 */
export function activeBuildMeta(store: Store): {
  buildId: Id | null;
  stale: boolean;
} {
  const build = readActiveBuild(store.db);
  if (build === null) return { buildId: null, stale: false };
  return { buildId: build.id, stale: inputsChanged(store, build) };
}

/**
 * The ledger generation referenced by the active build, reconstructed from
 * retained evidence. Returns null when no generation is active.
 */
export function activeLedgerSnapshot(store: Store): LedgerSnapshot | null {
  const build = readActiveBuild(store.db);
  if (build === null) return null;
  return loadLedgerSnapshot(store.db, build.ledger_build_id);
}

/**
 * Switches the active pointer to a retained successful generation. Failed or
 * cancelled candidates cannot be restored. A generation whose inputs no longer
 * match is marked stale; raw imports, decisions, and identities are untouched.
 */
export async function rollbackBuild(store: Store, buildId: Id): Promise<void> {
  const build = readBuild(store.db, buildId);
  if (build === null) {
    throw new AppError(
      "BUILD_NOT_FOUND",
      `No build exists for id ${buildId}.`,
      404,
    );
  }
  if (build.status === "failed" || build.status === "cancelled") {
    throw new AppError(
      "BUILD_NOT_ROLLBACKABLE",
      `Build ${buildId} is ${build.status} and cannot be restored.`,
      409,
    );
  }
  const stale = inputsChanged(store, build);
  await switchActiveBuild(
    store,
    buildId,
    stale ? "stale" : "active",
    new Date().toISOString(),
  );
}

/**
 * Startup recovery: any build left non-terminal by an interrupted process is
 * marked failed with retained diagnostics and is never made active.
 */
export async function recoverBuilds(store: Store): Promise<void> {
  await failInterruptedBuilds(store, new Date().toISOString());
}

interface PendingRequest {
  input: RebuildInput;
  resolve: (result: BuildResult) => void;
  reject: (error: unknown) => void;
  onJob?: (jobId: Id) => void;
}

/** Combines several abort signals without relying on AbortSignal.any. */
function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Minimal coalescing scheduler. Rebuild requests that arrive in the same tick
 * batch into one rebuild; the batch picks full mode when any request is full.
 * One persisted job row is emitted per batch with stage progress updates. Each
 * batch gets its own abort controller, registered with the shared JobService,
 * so cancelling the job stops the build before it can activate.
 */
export class BuildScheduler {
  private pending: PendingRequest[] = [];
  private scheduled = false;
  private flushing = false;

  constructor(
    private readonly store: Store,
    private readonly options: BuildServiceOptions = {},
    private readonly jobs: JobService = new JobService(store),
  ) {}

  request(input: RebuildInput): Promise<BuildResult> {
    return new Promise<BuildResult>((resolve, reject) => {
      this.enqueue({ input, resolve, reject });
    });
  }

  /**
   * Enqueues a rebuild and resolves with the persisted job id as soon as the
   * batch starts, before the build finishes. Callers poll the job for progress.
   */
  submit(input: RebuildInput): Promise<Id> {
    return new Promise<Id>((resolve, reject) => {
      this.enqueue({ input, resolve: () => {}, reject, onJob: resolve });
    });
  }

  private enqueue(entry: PendingRequest): void {
    this.pending.push(entry);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        void this.flush();
      });
    }
  }

  private async flush(): Promise<void> {
    this.scheduled = false;
    if (this.flushing) return;
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    this.flushing = true;
    try {
      const result = await this.runBatch(batch);
      for (const entry of batch) entry.resolve(result);
    } catch (error) {
      for (const entry of batch) entry.reject(error);
    } finally {
      this.flushing = false;
      if (this.pending.length > 0 && !this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    }
  }

  private runBatch(batch: PendingRequest[]): Promise<BuildResult> {
    const controller = new AbortController();
    const run = this.executeBatch(batch, controller);
    BUILD_CONTROLLERS.add(controller);
    IN_FLIGHT_BUILDS.add(run);
    const cleanup = () => {
      BUILD_CONTROLLERS.delete(controller);
      IN_FLIGHT_BUILDS.delete(run);
    };
    run.then(cleanup, cleanup);
    return run;
  }

  private async executeBatch(
    batch: PendingRequest[],
    controller: AbortController,
  ): Promise<BuildResult> {
    const first = batch[0];
    if (first === undefined) {
      throw new AppError("EMPTY_BATCH", "No rebuild requests to run.", 500);
    }
    const mode = batch.some((entry) => entry.input.mode === "full")
      ? "full"
      : "projection";
    const merged: RebuildInput = {
      mode,
      parserVersion: first.input.parserVersion,
      algorithmVersion: first.input.algorithmVersion,
      signal: combineSignals([
        controller.signal,
        ...batch.map((entry) => entry.input.signal),
      ]),
    };
    const jobId = await this.jobs.create("rebuild", {
      mode: merged.mode,
      parserVersion: merged.parserVersion,
      algorithmVersion: merged.algorithmVersion,
      requests: batch.length,
    });
    this.jobs.register(jobId, controller);
    for (const entry of batch) entry.onJob?.(jobId);
    await this.jobs.progress(jobId, "computing");
    try {
      const result = await rebuild(this.store, merged, this.options);
      await this.jobs.finish(
        jobId,
        result.status === "active" ? "complete" : result.status,
      );
      return result;
    } catch (error) {
      await this.jobs.finish(
        jobId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}

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
import {
  LEDGER_PARSER_VERSION,
  normalizeLedger,
  readLedger,
} from "../ledger/normalize.js";
import { type Store, write } from "../storage/database.js";
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
}

/**
 * Minimal coalescing scheduler. Rebuild requests that arrive in the same tick
 * batch into one rebuild; the batch picks full mode when any request is full.
 * One persisted job row is emitted per batch with stage progress updates. Task
 * 10 observes the persisted rows; no HTTP concerns live here.
 */
export class BuildScheduler {
  private pending: PendingRequest[] = [];
  private scheduled = false;
  private flushing = false;

  constructor(
    private readonly store: Store,
    private readonly options: BuildServiceOptions = {},
  ) {}

  request(input: RebuildInput): Promise<BuildResult> {
    return new Promise<BuildResult>((resolve, reject) => {
      this.pending.push({ input, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    });
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

  private async runBatch(batch: PendingRequest[]): Promise<BuildResult> {
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
      signal: first.input.signal,
    };
    const now = functionNow(this.options);
    const jobId = await this.createJob(
      merged,
      batch.length,
      now().toISOString(),
    );
    await this.updateJob(jobId, "computing");
    try {
      const result = await rebuild(this.store, merged, this.options);
      await this.finishJob(
        jobId,
        result.status === "active" ? "complete" : result.status,
        now().toISOString(),
      );
      return result;
    } catch (error) {
      await this.finishJob(
        jobId,
        "failed",
        now().toISOString(),
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private createJob(
    input: RebuildInput,
    requests: number,
    at: string,
  ): Promise<Id> {
    return write(this.store, () => {
      const id = randomUUID();
      this.store.db
        .prepare(
          `INSERT INTO jobs (id, kind, input_snapshot, status, progress, created_at)
           VALUES (?, 'rebuild', ?, 'running', 'queued', ?)`,
        )
        .run(
          id,
          JSON.stringify({
            mode: input.mode,
            parserVersion: input.parserVersion,
            algorithmVersion: input.algorithmVersion,
            requests,
          }),
          at,
        );
      return id;
    });
  }

  private updateJob(jobId: Id, progress: string): Promise<void> {
    return write(this.store, () => {
      this.store.db
        .prepare(`UPDATE jobs SET progress = ? WHERE id = ?`)
        .run(progress, jobId);
    });
  }

  private finishJob(
    jobId: Id,
    status: string,
    at: string,
    error?: string,
  ): Promise<void> {
    return write(this.store, () => {
      this.store.db
        .prepare(
          `UPDATE jobs SET status = ?, progress = ?, finished_at = ?, error = ?
           WHERE id = ?`,
        )
        .run(status, status, at, error ?? null, jobId);
    });
  }
}

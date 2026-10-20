import type {
  BuildResult,
  Id,
  Issue,
  LedgerSnapshot,
  Projection,
  Strategy,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { ValuationSnapshotSchema } from "../../shared/lifecycles.js";
import {
  findStrategyId,
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
import { accountLifecycles } from "../lifecycles/accounting.js";
import {
  projectLifecycles,
  validateMembership,
} from "../lifecycles/project.js";
import { readLifecycleAnchors } from "../lifecycles/repository.js";
import { valueLifecycles } from "../lifecycles/valuation.js";
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
  isRestorable,
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
  retainedNormalizationInputsChanged,
  snapshotInputs,
} from "./snapshot.js";

export const ALGORITHM_VERSION = "lifecycles-v5";

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
    const anchor = { account, openingKeys: keys };
    // Retained bindings already use durable IDs. Resolve known anchors before
    // grouping so their openings and bound closes share the same draft.
    const existing = findStrategyId(store, anchor);
    if (existing !== null) return existing;
    const key = strategyAnchorKey(anchor);
    anchors.set(key, { account, openingKeys: [...keys] });
    return key;
  };
  const provisional = groupStrategies(ledger, decisions, resolveId);
  const origins = groupStrategies(
    ledger,
    decisions.filter((d) => d.kind !== "group_merge"),
    resolveId,
  );
  const remap = new Map<Id, Id>();
  for (const [key, anchor] of anchors) {
    remap.set(key, await strategyId(store, anchor));
  }
  const projection = accountProjection(
    ledger,
    remapStrategyIds(provisional, remap),
  );
  const lifecycles = accountLifecycles(
    ledger,
    projection,
    projectLifecycles(
      ledger,
      projection,
      decisions,
      undefined,
      remapStrategyIds(origins, remap),
      readLifecycleAnchors(store.db),
    ),
  );
  const snapshots = decisions
    .filter((d) => d.kind === "lifecycle_valuation")
    .map((d) => ValuationSnapshotSchema.parse(d.payload));
  lifecycles.valuations = valueLifecycles(ledger, lifecycles, snapshots);
  const conservation = validateMembership(
    ledger,
    projection,
    lifecycles.members,
  );
  if (conservation.length)
    throw new AppError(
      "LIFECYCLE_CONSERVATION",
      "Lifecycle memberships do not conserve source allocations.",
      409,
    );
  projection.lifecycles = lifecycles;
  projection.issues.push(...lifecycles.issues);
  return withLedgerIssues(projection, ledger.issues);
}

/**
 * Adds the ledger's own issues (identity/alias/binding conflicts and
 * quarantined evidence) to the projection's review items. The Review surface
 * reads only projection issues, so without this a ledger-level diagnostic such
 * as a contradictory identity binding would be persisted but never shown.
 * Deduplicated by stable key and sorted so the result stays deterministic.
 */
function withLedgerIssues(
  projection: Projection,
  ledgerIssues: readonly Issue[],
): Projection {
  const seen = new Set(projection.issues.map((issue) => issue.key));
  const issues = [...projection.issues];
  for (const issue of ledgerIssues) {
    if (seen.has(issue.key)) continue;
    seen.add(issue.key);
    issues.push(issue);
  }
  issues.sort((left, right) => (left.key < right.key ? -1 : 1));
  return { ...projection, issues };
}

function readRetainedLedger(
  store: Store,
  parserVersion: string,
  currentWatermark: number,
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
  if (
    retainedNormalizationInputsChanged(
      store,
      retained.id,
      currentWatermark,
      parserVersion,
    )
  ) {
    throw new AppError(
      "BUILD_INPUTS_CHANGED",
      "The retained ledger no longer matches current normalization rules, imports, or identity/inclusion decisions. Run a full rebuild before a projection rebuild.",
      409,
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

  const snapshot = snapshotInputs(store, input.parserVersion);
  const ledger =
    input.mode === "full"
      ? await normalizeLedger(store, {
          parserVersion: input.parserVersion,
          decisionWatermark: snapshot.watermark,
        })
      : readRetainedLedger(store, input.parserVersion, snapshot.watermark);

  const buildId = await insertCandidate(store, {
    ledgerId: ledger.id,
    watermark: snapshot.watermark,
    algorithmVersion: input.algorithmVersion,
    inputHash: snapshot.hash,
    now: now().toISOString(),
  });

  try {
    return await completeCandidate(store, buildId, ledger, snapshot.watermark, {
      input,
      options,
      now,
    });
  } catch (error) {
    // A candidate must never stay "running" after its build gave up: record
    // why it failed so it is retained as diagnostics and never restorable.
    // The original error is always the one surfaced; if this write fails too,
    // startup recovery still fails the candidate.
    await markBuildStatus(
      store,
      buildId,
      "failed",
      [buildFailureIssue(error)],
      now().toISOString(),
    ).catch(() => undefined);
    throw error;
  }
}

function buildFailureIssue(error: unknown): Issue {
  const code = error instanceof AppError ? error.code : "BUILD_FAILED";
  return { key: `build:${code}`, code, sources: [], severity: "error" };
}

interface CandidateContext {
  input: RebuildInput;
  options: BuildServiceOptions;
  now: () => Date;
}

/**
 * Computes, persists, validates and (when valid and current) activates an
 * inserted candidate. Every return leaves the candidate in a terminal status.
 */
async function completeCandidate(
  store: Store,
  buildId: Id,
  ledger: LedgerSnapshot,
  watermark: number,
  { input, options, now }: CandidateContext,
): Promise<BuildResult> {
  const projection = await computeProjection(store, ledger, watermark);
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
    stale:
      inputsChanged(store, build) ||
      build.algorithm_version !== ALGORITHM_VERSION,
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
 * Switches the active pointer to a retained successful generation. Only an
 * active or stale build can be restored; running, failed and cancelled
 * candidates cannot. A generation whose inputs no longer match is marked
 * stale; raw imports, decisions, and identities are untouched.
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
  if (!isRestorable(build.status)) {
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
  hasActiveWork(): boolean {
    return this.scheduled || this.flushing || this.pending.length > 0;
  }

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
    try {
      for (const entry of batch) entry.onJob?.(jobId);
      await this.jobs.progress(jobId, "computing");
      const result = await rebuild(this.store, merged, this.options);
      await this.jobs.finishIfRunning(
        jobId,
        // A stale candidate finished computing but cannot be activated. Keep
        // staleness on the build; jobs must use a terminal polling status.
        result.status === "active" || result.status === "stale"
          ? "complete"
          : result.status,
      );
      return result;
    } catch (error) {
      // Finalization releases the in-process registration even if its database
      // write fails. Preserve the work's original error; startup recovery will
      // interrupt any persisted job that could not be marked terminal.
      await this.jobs
        .finishIfRunning(
          jobId,
          merged.signal.aborted ? "cancelled" : "failed",
          error instanceof Error ? error.message : String(error),
        )
        .catch(() => undefined);
      throw error;
    }
  }
}

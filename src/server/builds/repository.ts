import { randomUUID } from "node:crypto";
import type {
  Allocation,
  Id,
  Issue,
  Projection,
  Strategy,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { decisionWatermark } from "../decisions/service.js";
import {
  loadLifecycleProjection,
  persistLifecycleProjection,
} from "../lifecycles/repository.js";
import { type Store, write } from "../storage/database.js";
import { manifestHash } from "../storage/ledger.js";
import { readCommittedImportRefs } from "./snapshot.js";

export type BuildStatus =
  | "running"
  | "active"
  | "stale"
  | "failed"
  | "cancelled";

export interface BuildRow {
  id: string;
  ledger_build_id: string;
  decision_watermark: number;
  algorithm_version: string;
  input_hash: string;
  status: string;
  validation_json: string;
  created_at: string;
  finished_at: string | null;
}

export interface CandidateDraft {
  ledgerId: Id;
  watermark: number;
  algorithmVersion: string;
  inputHash: string;
  now: string;
}

const NON_TERMINAL = ["running", "candidate", "validating"] as const;

/** Only a generation that completed validation can be made active again. */
export function isRestorable(status: string): boolean {
  return status === "active" || status === "stale";
}

export function readBuild(db: Store["db"], id: Id): BuildRow | null {
  const row = db
    .prepare(
      `SELECT id, ledger_build_id, decision_watermark, algorithm_version,
              input_hash, status, validation_json, created_at, finished_at
       FROM builds WHERE id = ?`,
    )
    .get(id) as BuildRow | undefined;
  return row ?? null;
}

export function readActiveBuild(db: Store["db"]): BuildRow | null {
  const row = db
    .prepare(
      `SELECT b.id, b.ledger_build_id, b.decision_watermark, b.algorithm_version,
              b.input_hash, b.status, b.validation_json, b.created_at, b.finished_at
       FROM app_state s
       JOIN builds b ON b.id = s.active_build_id
       WHERE s.singleton = 1`,
    )
    .get() as BuildRow | undefined;
  return row ?? null;
}

/**
 * Inserts a candidate build row in the non-terminal "running" state. The
 * candidate carries the ledger generation, the decision watermark, and the
 * exact input hash it was computed from so activation can compare them.
 */
export async function insertCandidate(
  store: Store,
  draft: CandidateDraft,
): Promise<Id> {
  return write(store, () => {
    const id = randomUUID();
    store.db
      .prepare(
        `INSERT INTO builds (
           id, ledger_build_id, decision_watermark, algorithm_version,
           input_hash, status, validation_json, created_at
         ) VALUES (?, ?, ?, ?, ?, 'running', '[]', ?)`,
      )
      .run(
        id,
        draft.ledgerId,
        draft.watermark,
        draft.algorithmVersion,
        draft.inputHash,
        draft.now,
      );
    return id;
  });
}

function ensureStrategyIdentity(db: Store["db"], id: Id, now: string): void {
  const existing = db
    .prepare("SELECT 1 FROM strategy_identities WHERE id = ?")
    .get(id);
  if (existing !== undefined) return;
  db.prepare(
    `INSERT INTO strategy_identities (id, stable_anchor_key, created_at)
     VALUES (?, ?, ?)`,
  ).run(id, `strategy:${id}`, now);
}

function headRevisionId(
  db: Store["db"],
  ledgerId: Id,
  executionKey: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM transaction_revisions
       WHERE ledger_build_id = ? AND logical_transaction_key = ?
         AND revision_state = 'active'
       ORDER BY revision_number DESC LIMIT 1`,
    )
    .get(ledgerId, executionKey) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Persists a computed projection for one build inside a single serialized
 * transaction: every strategy field, its positions, its allocations (mapped to
 * the ledger's active head revision), cross-strategy links, and the review
 * items that carry the grouping/accounting issues. No field the shared types
 * carry is dropped.
 */
export async function persistProjection(
  store: Store,
  buildId: Id,
  ledgerId: Id,
  projection: Projection,
  now: string,
): Promise<void> {
  await write(store, () => {
    const db = store.db;
    const strategyIds = new Set(
      projection.strategies.map((strategy) => strategy.id),
    );

    const insertView = db.prepare(
      `INSERT INTO strategy_views (
         build_id, strategy_id, description, type, currency, opening_date,
         close_date, expiry, expiry_year, status, history_complete,
         opening_amount, realized_pnl, remaining_exposure, broker_pnl,
         reconstructed_pnl, cashflow, reasons_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPosition = db.prepare(
      `INSERT INTO position_views (
         build_id, strategy_id, instrument_key, remaining_quantity, basis,
         completeness
       ) VALUES (?, ?, ?, ?, NULL, ?)`,
    );
    for (const strategy of projection.strategies) {
      ensureStrategyIdentity(db, strategy.id, now);
      insertView.run(
        buildId,
        strategy.id,
        strategy.description,
        strategy.type,
        strategy.currency,
        strategy.openingDate,
        strategy.closeDate,
        strategy.expiry,
        strategy.expiryYear,
        strategy.status,
        strategy.complete ? 1 : 0,
        strategy.openingAmount,
        null,
        null,
        strategy.brokerPnl,
        strategy.reconstructedPnl,
        strategy.cashflow,
        JSON.stringify(strategy.reasons),
      );
      for (const position of strategy.positions) {
        insertPosition.run(
          buildId,
          strategy.id,
          position.instrumentKey,
          position.quantity,
          strategy.complete ? "complete" : "incomplete",
        );
      }
    }

    const insertAllocation = db.prepare(
      `INSERT INTO strategy_allocations (
         build_id, ledger_build_id, strategy_id, revision_id, allocation_role,
         allocated_quantity, allocated_cash, broker_pnl, pnl_estimated, pnl_attribution
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // The allocation primary key is (build, strategy, revision, role). A second
    // row for the same key must never hard-fail the build via a SQL constraint;
    // skip it and surface a review item instead.
    const allocationKeys = new Set<string>();
    const duplicateIssues: Issue[] = [];
    for (const allocation of projection.allocations) {
      if (!strategyIds.has(allocation.strategyId)) continue;
      const revisionId = headRevisionId(db, ledgerId, allocation.executionKey);
      if (revisionId === null) continue;
      const allocationKey = `${allocation.strategyId}\u0000${revisionId}\u0000${allocation.role}`;
      if (allocationKeys.has(allocationKey)) {
        duplicateIssues.push({
          key: `build:DUPLICATE_ALLOCATION:${allocation.strategyId}:${allocation.executionKey}:${allocation.role}`,
          code: "DUPLICATE_ALLOCATION",
          sources: [],
          severity: "warning",
        });
        continue;
      }
      allocationKeys.add(allocationKey);
      insertAllocation.run(
        buildId,
        ledgerId,
        allocation.strategyId,
        revisionId,
        allocation.role,
        allocation.quantity,
        allocation.netCash,
        allocation.brokerPnl,
        allocation.pnlEstimated ? 1 : 0,
        allocation.pnlAttribution ?? null,
      );
    }

    const insertLink = db.prepare(
      `INSERT INTO strategy_links (
         build_id, source_strategy_id, target_strategy_id, link_type,
         event_reference_json, source_references_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const link of projection.links) {
      if (!strategyIds.has(link.from) || !strategyIds.has(link.to)) continue;
      if (link.from === link.to) continue;
      insertLink.run(
        buildId,
        link.from,
        link.to,
        link.type,
        JSON.stringify({ type: link.type }),
        JSON.stringify(link.sources),
      );
    }

    if (projection.lifecycles)
      persistLifecycleProjection(db, buildId, projection.lifecycles);

    const insertIssue = db.prepare(
      `INSERT INTO review_items (
         build_id, stable_issue_key, reason, source_references_json,
         candidate_json, severity
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const issue of [...projection.issues, ...duplicateIssues]) {
      insertIssue.run(
        buildId,
        issue.key,
        issue.code,
        JSON.stringify(issue.sources),
        "{}",
        issue.severity,
      );
    }
  });
}

function readReasons(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** Reconstructs a projection from the persisted build tables. */
export function loadProjection(db: Store["db"], buildId: Id): Projection {
  const build = readBuild(db, buildId);
  if (build === null) {
    throw new AppError(
      "BUILD_NOT_FOUND",
      `No build exists for id ${buildId}.`,
      404,
    );
  }

  const viewRows = db
    .prepare(
      `SELECT strategy_id, description, type, currency, opening_date,
              close_date, expiry, expiry_year, status, history_complete,
              opening_amount, broker_pnl, reconstructed_pnl, cashflow,
              reasons_json
       FROM strategy_views WHERE build_id = ? ORDER BY strategy_id`,
    )
    .all(buildId) as Array<{
    strategy_id: string;
    description: string;
    type: string;
    currency: string;
    opening_date: string | null;
    close_date: string | null;
    expiry: string | null;
    expiry_year: number | null;
    status: string;
    history_complete: number;
    opening_amount: string | null;
    broker_pnl: string | null;
    reconstructed_pnl: string | null;
    cashflow: string | null;
    reasons_json: string;
  }>;

  const positionRows = db
    .prepare(
      `SELECT strategy_id, instrument_key, remaining_quantity
       FROM position_views WHERE build_id = ?
       ORDER BY strategy_id, instrument_key`,
    )
    .all(buildId) as Array<{
    strategy_id: string;
    instrument_key: string;
    remaining_quantity: string;
  }>;
  const positionsByStrategy = new Map<string, Strategy["positions"]>();
  for (const row of positionRows) {
    const entries = positionsByStrategy.get(row.strategy_id) ?? [];
    entries.push({
      instrumentKey: row.instrument_key,
      quantity: row.remaining_quantity,
    });
    positionsByStrategy.set(row.strategy_id, entries);
  }

  const strategies: Strategy[] = viewRows.map((row) => ({
    id: row.strategy_id,
    type: row.type,
    currency: row.currency,
    description: row.description,
    openingDate: row.opening_date,
    closeDate: row.close_date,
    expiry: row.expiry,
    expiryYear: row.expiry_year,
    status: row.status as Strategy["status"],
    complete: row.history_complete === 1,
    openingAmount: row.opening_amount,
    cashflow: row.cashflow,
    brokerPnl: row.broker_pnl,
    reconstructedPnl: row.reconstructed_pnl,
    positions: positionsByStrategy.get(row.strategy_id) ?? [],
    reasons: readReasons(row.reasons_json),
  }));

  const allocationRows = db
    .prepare(
      `SELECT sa.strategy_id, tr.logical_transaction_key AS execution_key,
              sa.allocation_role, sa.allocated_quantity, sa.allocated_cash,
              sa.broker_pnl, sa.pnl_estimated, sa.pnl_attribution
       FROM strategy_allocations sa
       JOIN transaction_revisions tr
         ON tr.id = sa.revision_id AND tr.ledger_build_id = sa.ledger_build_id
       WHERE sa.build_id = ?
       ORDER BY sa.strategy_id, tr.logical_transaction_key, sa.allocation_role`,
    )
    .all(buildId) as Array<{
    strategy_id: string;
    execution_key: string;
    allocation_role: string;
    allocated_quantity: string;
    allocated_cash: string | null;
    broker_pnl: string | null;
    pnl_estimated: number;
    pnl_attribution: NonNullable<Allocation["pnlAttribution"]> | null;
  }>;
  const allocations: Allocation[] = allocationRows.map((row) => ({
    strategyId: row.strategy_id,
    executionKey: row.execution_key,
    quantity: row.allocated_quantity,
    netCash: row.allocated_cash ?? "",
    brokerPnl: row.broker_pnl,
    pnlEstimated: row.pnl_estimated === 1,
    ...(row.pnl_attribution === null
      ? {}
      : { pnlAttribution: row.pnl_attribution }),
    role: row.allocation_role as Allocation["role"],
  }));

  const linkRows = db
    .prepare(
      `SELECT source_strategy_id, target_strategy_id, link_type,
              source_references_json
       FROM strategy_links WHERE build_id = ?
       ORDER BY source_strategy_id, target_strategy_id, link_type`,
    )
    .all(buildId) as Array<{
    source_strategy_id: string;
    target_strategy_id: string;
    link_type: string;
    source_references_json: string;
  }>;
  const links: Projection["links"] = linkRows.map((row) => ({
    from: row.source_strategy_id,
    to: row.target_strategy_id,
    type: row.link_type,
    sources: JSON.parse(
      row.source_references_json,
    ) as Projection["links"][number]["sources"],
  }));

  const issueRows = db
    .prepare(
      `SELECT stable_issue_key, reason, source_references_json, severity
       FROM review_items WHERE build_id = ? ORDER BY stable_issue_key`,
    )
    .all(buildId) as Array<{
    stable_issue_key: string;
    reason: string;
    source_references_json: string;
    severity: string;
  }>;
  const issues: Issue[] = issueRows.map((row) => ({
    key: row.stable_issue_key,
    code: row.reason,
    sources: JSON.parse(row.source_references_json) as Issue["sources"],
    severity: row.severity as Issue["severity"],
  }));

  const lifecycles = loadLifecycleProjection(db, buildId);
  return {
    ...(lifecycles ? { lifecycles } : {}),
    ledgerId: build.ledger_build_id,
    watermark: build.decision_watermark,
    strategies,
    allocations,
    links,
    issues,
  };
}

/** Records a terminal status plus the retained diagnostics for a candidate. */
export async function markBuildStatus(
  store: Store,
  buildId: Id,
  status: BuildStatus,
  issues: readonly Issue[],
  now: string,
): Promise<void> {
  await write(store, () => {
    store.db
      .prepare(
        `UPDATE builds
         SET status = ?, validation_json = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(status, JSON.stringify(issues), now, buildId);
  });
}

export interface ActivationResult {
  status: "active" | "stale";
}

/**
 * Atomic compare-and-switch. In one serialized transaction it re-reads the
 * current decision watermark and import manifest; the singleton active pointer
 * moves only when they still match the candidate's recorded inputs. Otherwise
 * the candidate is marked stale and the pointer is left where it was.
 */
export async function activateIfCurrent(
  store: Store,
  buildId: Id,
  parserVersion: string,
  issues: readonly Issue[],
  now: string,
): Promise<ActivationResult> {
  return write(store, () => {
    const build = readBuild(store.db, buildId);
    if (build === null) {
      throw new AppError(
        "BUILD_NOT_FOUND",
        `No build exists for id ${buildId}.`,
        404,
      );
    }
    const imports = readCommittedImportRefs(store.db);
    const watermark = decisionWatermark(store);
    const currentHash = manifestHash(parserVersion, watermark, imports);
    const current =
      build.input_hash === currentHash &&
      build.decision_watermark === watermark;

    if (!current) {
      store.db
        .prepare(
          `UPDATE builds SET status = 'stale', validation_json = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(issues), now, buildId);
      return { status: "stale" };
    }

    store.db
      .prepare(
        `UPDATE builds SET status = 'stale' WHERE status = 'active' AND id <> ?`,
      )
      .run(buildId);
    store.db
      .prepare(
        `UPDATE builds SET status = 'active', validation_json = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(issues), now, buildId);
    store.db
      .prepare(
        `UPDATE app_state SET active_build_id = ?, updated_at = ? WHERE singleton = 1`,
      )
      .run(buildId, now);
    return { status: "active" };
  });
}

export interface RollbackResult {
  status: "active" | "stale";
}

/**
 * Switches the singleton active pointer to a retained successful generation in
 * one transaction, marking it stale when current inputs no longer match. The
 * build's status is re-read inside the transaction, so a build that failed
 * after the caller checked it is never activated.
 */
export async function switchActiveBuild(
  store: Store,
  buildId: Id,
  status: "active" | "stale",
  now: string,
): Promise<RollbackResult> {
  return write(store, () => {
    const build = readBuild(store.db, buildId);
    if (build === null || !isRestorable(build.status)) {
      throw new AppError(
        "BUILD_NOT_ROLLBACKABLE",
        `Build ${buildId} is ${build?.status ?? "missing"} and cannot be restored.`,
        409,
      );
    }
    store.db
      .prepare(
        `UPDATE builds SET status = 'stale' WHERE status = 'active' AND id <> ?`,
      )
      .run(buildId);
    store.db
      .prepare(`UPDATE builds SET status = ? WHERE id = ?`)
      .run(status, buildId);
    store.db
      .prepare(
        `UPDATE app_state SET active_build_id = ?, updated_at = ? WHERE singleton = 1`,
      )
      .run(buildId, now);
    return { status };
  });
}

/**
 * Marks every build left in a non-terminal state by an interrupted process as
 * failed. Such a candidate is never activated; a pointer to a failed build is
 * cleared so the last valid generation is retained.
 */
export async function failInterruptedBuilds(
  store: Store,
  now: string,
): Promise<void> {
  await write(store, () => {
    const states = [...NON_TERMINAL];
    const placeholders = states.map(() => "?").join(", ");
    store.db
      .prepare(
        `UPDATE builds
         SET status = 'failed',
             validation_json = ?,
             finished_at = ?
         WHERE status IN (${placeholders})`,
      )
      .run(
        JSON.stringify([
          {
            key: "build:BUILD_INTERRUPTED",
            code: "BUILD_INTERRUPTED",
            sources: [],
            severity: "error",
          },
        ]),
        now,
        ...states,
      );
    store.db
      .prepare(
        `UPDATE app_state SET active_build_id = NULL
         WHERE active_build_id IN (SELECT id FROM builds WHERE status = 'failed')`,
      )
      .run();
  });
}

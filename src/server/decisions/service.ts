import { randomUUID } from "node:crypto";
import type { Id, SourceRef } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { loadProjection, readActiveBuild } from "../builds/repository.js";
import { retainedNormalizationInputsChanged } from "../builds/snapshot.js";
import { LEDGER_PARSER_VERSION } from "../ledger/normalize.js";
import { readLifecycleAnchors } from "../lifecycles/repository.js";
import { validateLifecycleDecision } from "../lifecycles/validate-decision.js";
import { type Store, write } from "../storage/database.js";
import { loadLedgerSnapshot } from "../storage/ledger.js";
import { groupStrategies } from "../strategies/grouping.js";
import { findStrategyId, strategyAnchorKey } from "./registry.js";
import {
  DECISION_KINDS,
  type DecisionInput,
  DecisionInputSchema,
} from "./schemas.js";

export interface Decision {
  id: Id;
  sequence: number;
  kind: string;
  sources: SourceRef[];
  strategyIds: Id[];
  payload: Record<string, unknown>;
  supersedesId: Id | null;
  clientRequestId: string;
  author: string;
  createdAt: string;
}

interface DecisionRow {
  id: string;
  sequence: number;
  kind: string;
  source_refs_json: string;
  strategy_ids_json: string;
  payload_json: string;
  supersedes_id: string | null;
  client_request_id: string;
  author: string;
  created_at: string;
}

function readDecisionRow(row: DecisionRow): Decision {
  return {
    id: row.id,
    sequence: row.sequence,
    kind: row.kind,
    sources: JSON.parse(row.source_refs_json) as SourceRef[],
    strategyIds: JSON.parse(row.strategy_ids_json) as Id[],
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    supersedesId: row.supersedes_id,
    clientRequestId: row.client_request_id,
    author: row.author,
    createdAt: row.created_at,
  };
}

/**
 * Returns the high-water mark for the retained decisions table. Zero means
 * no decision has been appended yet; the next append must pass
 * expectedWatermark = 0 to succeed.
 */
export function decisionWatermark(store: Store): number {
  const row = store.db
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM decisions")
    .get() as { sequence: number };
  return row.sequence;
}

/**
 * Reads every retained decision with sequence <= watermark, in append order.
 * The watermark argument lets callers scope the read to a snapshot that was
 * already validated against the same ledger generation.
 */
export function readDecisions(store: Store, watermark: number): Decision[] {
  if (watermark < 0) return [];
  const rows = store.db
    .prepare(
      `SELECT id, sequence, kind, source_refs_json, strategy_ids_json,
              payload_json, supersedes_id, client_request_id, author, created_at
       FROM decisions
       WHERE sequence <= ?
       ORDER BY sequence`,
    )
    .all(watermark) as DecisionRow[];
  return rows.map(readDecisionRow);
}

/**
 * Returns the decisions that have not been superseded by a later decision with
 * matching intent. Supersession is tracked via the decisions.supersedes_id
 * column: a decision whose id appears in anyone else's supersedes_id is
 * filtered out, leaving only the latest non-superseded entry per lineage.
 */
export function effectiveDecisions(decisions: readonly Decision[]): Decision[] {
  const superseded = new Set<Id>();
  for (const decision of decisions) {
    if (decision.supersedesId !== null) superseded.add(decision.supersedesId);
  }
  return decisions.filter((decision) => !superseded.has(decision.id));
}

export interface StrategyMetadata {
  notes: string | null;
  stopLoss: string | null;
}

/**
 * Returns the effective retained metadata for one strategy: the latest
 * nonsuperseded `notes` and `stop_loss` decisions. Metadata is retained in the
 * decisions table and never touched by a rebuild, so this read survives a full
 * normalization without any projection being present.
 */
export function readStrategyMetadata(
  store: Store,
  strategyId: Id,
): StrategyMetadata {
  const decisions = effectiveDecisions(
    readDecisions(store, decisionWatermark(store)),
  );
  let notes: string | null = null;
  let stopLoss: string | null = null;
  for (const decision of decisions) {
    const payload = decision.payload;
    const payloadStrategyId =
      typeof payload.strategyId === "string" ? payload.strategyId : undefined;
    const targetsStrategy =
      payloadStrategyId === strategyId ||
      decision.strategyIds.includes(strategyId);
    if (!targetsStrategy) continue;
    if (decision.kind === "notes" && typeof payload.text === "string") {
      notes = payload.text;
    } else if (
      decision.kind === "stop_loss" &&
      typeof payload.price === "string"
    ) {
      stopLoss = payload.price;
    }
  }
  return { notes, stopLoss };
}

function activeLedgerBuildId(
  db: import("better-sqlite3").Database,
): string | null {
  const row = db
    .prepare(`SELECT active_build_id AS id FROM app_state WHERE singleton = 1`)
    .get() as { id: string | null } | undefined;
  return row?.id ?? null;
}

function ledgerBuildIdForBuild(
  db: import("better-sqlite3").Database,
  buildId: string | null,
): string | null {
  if (buildId === null) return null;
  const row = db
    .prepare(`SELECT ledger_build_id AS id FROM builds WHERE id = ?`)
    .get(buildId) as { id: string } | undefined;
  return row?.id ?? null;
}

function resolveLedgerBuildId(
  db: import("better-sqlite3").Database,
): string | null {
  return ledgerBuildIdForBuild(db, activeLedgerBuildId(db));
}

interface SourceValidation {
  ok: boolean;
  reason?: string;
}

function findImportRowId(
  db: import("better-sqlite3").Database,
  source: SourceRef,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM import_rows WHERE import_id = ? AND row_number = ?`,
    )
    .get(source.importId, source.rowNumber) as { id: string } | undefined;
  return row?.id ?? null;
}

function validateSourceAgainstLedger(
  db: import("better-sqlite3").Database,
  source: SourceRef,
): SourceValidation {
  const importRowId = findImportRowId(db, source);
  if (importRowId === null) {
    return { ok: false, reason: `Source row not found` };
  }
  const ledgerBuildId = resolveLedgerBuildId(db);
  if (ledgerBuildId === null) {
    return { ok: false, reason: `No active ledger build` };
  }
  const referenced = db
    .prepare(
      `SELECT 1 FROM transaction_sources ts
       WHERE ts.import_row_id = ?
         AND ts.ledger_build_id = ?
       LIMIT 1`,
    )
    .get(importRowId, ledgerBuildId);
  if (referenced !== undefined) return { ok: true };
  const lotReferenced = db
    .prepare(
      `SELECT 1 FROM lot_details ld
       WHERE ld.import_row_id = ? AND ld.ledger_build_id = ?
       LIMIT 1`,
    )
    .get(importRowId, ledgerBuildId);
  return lotReferenced !== undefined
    ? { ok: true }
    : { ok: false, reason: `Source not referenced by current ledger` };
}

function validateIdentityBindingQuantity(
  db: import("better-sqlite3").Database,
  source: SourceRef,
  expectedQuantity: string,
): SourceValidation {
  const importRowId = findImportRowId(db, source);
  if (importRowId === null) {
    return { ok: false, reason: `Source row not found` };
  }
  const ledgerBuildId = resolveLedgerBuildId(db);
  if (ledgerBuildId === null) {
    return { ok: false, reason: `No active ledger build` };
  }
  const row = db
    .prepare(
      `SELECT signed_quantity FROM transaction_sources ts
       JOIN transaction_revisions tr ON tr.id = ts.revision_id
       WHERE ts.import_row_id = ? AND ts.ledger_build_id = ? LIMIT 1`,
    )
    .get(importRowId, ledgerBuildId) as { signed_quantity: string } | undefined;
  if (row === undefined) return { ok: true };
  return row.signed_quantity === expectedQuantity
    ? { ok: true }
    : {
        ok: false,
        reason: `Source quantity ${row.signed_quantity} does not match decision expected ${expectedQuantity}`,
      };
}

interface AllocationValidation {
  ok: boolean;
  reason?: string;
}

function validateAllocationsAgainstExistingDecisions(
  db: import("better-sqlite3").Database,
  source: SourceRef,
  strategyId: Id,
  supersedesId: Id | null,
): AllocationValidation {
  const conflictRows = db
    .prepare(
      `SELECT id, strategy_ids_json, supersedes_id FROM decisions
       WHERE kind = 'manual_allocation' AND id <> ?`,
    )
    .all(supersedesId ?? "") as Array<{
    id: string;
    strategy_ids_json: string;
    supersedes_id: string | null;
  }>;
  const superseded = new Set<string>();
  for (const row of conflictRows) {
    if (row.supersedes_id !== null) superseded.add(row.supersedes_id);
  }
  const importRowId = findImportRowId(db, source);
  if (importRowId === null) {
    return { ok: false, reason: `Source row not found` };
  }
  for (const row of conflictRows) {
    if (superseded.has(row.id)) continue;
    const strategies = JSON.parse(row.strategy_ids_json) as Id[];
    const payloadMatch = db
      .prepare(`SELECT payload_json FROM decisions WHERE id = ?`)
      .get(row.id) as { payload_json: string } | undefined;
    if (payloadMatch === undefined) continue;
    const payload = JSON.parse(payloadMatch.payload_json) as {
      source?: SourceRef;
      strategyId?: Id;
    };
    if (payload.source?.importId !== source.importId) continue;
    if (payload.source?.rowNumber !== source.rowNumber) continue;
    if (strategies.includes(strategyId)) continue;
    return {
      ok: false,
      reason: `Execution already manually allocated to a different strategy`,
    };
  }
  return { ok: true };
}

interface StrategyDimension {
  account: string;
  currency: string;
}

function strategyDimensions(
  db: import("better-sqlite3").Database,
  strategyId: Id,
): StrategyDimension[] {
  const buildId = activeLedgerBuildId(db);
  if (buildId === null) return [];
  const rows = db
    .prepare(
      `SELECT DISTINCT a.broker_account_id AS account, r.currency AS currency
       FROM strategy_allocations sa
       JOIN transaction_revisions r
         ON r.ledger_build_id = sa.ledger_build_id AND r.id = sa.revision_id
       JOIN accounts a ON a.id = r.account_id
       WHERE sa.build_id = ? AND sa.strategy_id = ?`,
    )
    .all(buildId, strategyId) as StrategyDimension[];
  return rows;
}

function sourceDimensions(
  db: import("better-sqlite3").Database,
  source: SourceRef,
): StrategyDimension[] {
  const rowId = findImportRowId(db, source);
  const buildId = activeLedgerBuildId(db);
  if (rowId === null || buildId === null) return [];
  const ledgerBuildId = resolveLedgerBuildId(db);
  if (ledgerBuildId === null) return [];
  return db
    .prepare(
      `SELECT DISTINCT a.broker_account_id AS account, r.currency AS currency
       FROM transaction_sources ts
       JOIN transaction_revisions r
         ON r.ledger_build_id = ts.ledger_build_id AND r.id = ts.revision_id
       JOIN accounts a ON a.id = r.account_id
       WHERE ts.ledger_build_id = ? AND ts.import_row_id = ?`,
    )
    .all(ledgerBuildId, rowId) as StrategyDimension[];
}

function executionDimensions(
  db: import("better-sqlite3").Database,
  executionKey: string,
): StrategyDimension[] {
  const ledgerBuildId = resolveLedgerBuildId(db);
  if (ledgerBuildId === null) return [];
  return db
    .prepare(
      `SELECT DISTINCT a.broker_account_id AS account, r.currency AS currency
       FROM transaction_revisions r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.ledger_build_id = ? AND r.logical_transaction_key = ?`,
    )
    .all(ledgerBuildId, executionKey) as StrategyDimension[];
}

function assertCompatibleStrategyMembership(
  db: import("better-sqlite3").Database,
  source: SourceRef,
  strategyId: Id,
): void {
  const sourceRows = sourceDimensions(db, source);
  const strategyRows = strategyDimensions(db, strategyId);
  if (sourceRows.length === 0 || strategyRows.length === 0) return;
  const dimensions = new Set(
    [...sourceRows, ...strategyRows].map(
      ({ account, currency }) => `${account}\u0000${currency}`,
    ),
  );
  if (dimensions.size > 1) {
    throw new AppError(
      "INCOMPATIBLE_STRATEGY_MEMBERSHIP",
      `Strategy ${strategyId} cannot include evidence from a different account or currency.`,
      409,
    );
  }
}

function assertCompatibleStrategyMerge(
  db: import("better-sqlite3").Database,
  chosenStrategyId: Id,
  mergedStrategyIds: readonly Id[],
): void {
  const dimensions = new Set<string>();
  for (const strategyId of [chosenStrategyId, ...mergedStrategyIds]) {
    for (const { account, currency } of strategyDimensions(db, strategyId)) {
      dimensions.add(`${account}\u0000${currency}`);
    }
  }
  if (dimensions.size > 1) {
    throw new AppError(
      "INCOMPATIBLE_STRATEGY_MERGE",
      "Strategies from different accounts or currencies cannot be merged.",
      409,
    );
  }
}

function assertValidSource(
  db: import("better-sqlite3").Database,
  source: SourceRef,
): void {
  const result = validateSourceAgainstLedger(db, source);
  if (!result.ok) {
    throw new AppError(
      "INVALID_SOURCE",
      result.reason ?? "Invalid source",
      400,
    );
  }
}

function validateDecisionInput(
  store: { db: import("better-sqlite3").Database },
  input: DecisionInput,
  watermark: number,
): void {
  if (input.supersedesId !== null) {
    const target = store.db
      .prepare(`SELECT sequence FROM decisions WHERE id = ?`)
      .get(input.supersedesId) as { sequence: number } | undefined;
    if (target === undefined) {
      throw new AppError(
        "STALE_INPUT",
        `Supersede target ${input.supersedesId} does not exist.`,
        400,
      );
    }
    if (target.sequence >= watermark + 1) {
      throw new AppError(
        "STALE_INPUT",
        `Supersede target sequence ${target.sequence} is not earlier than the new decision.`,
        400,
      );
    }
  }
  switch (input.kind) {
    case "identity_binding":
      assertValidSource(store.db, input.payload.source);
      {
        const quantityCheck = validateIdentityBindingQuantity(
          store.db,
          input.payload.source,
          input.payload.expectedQuantity,
        );
        if (!quantityCheck.ok) {
          throw new AppError(
            "INVALID_SOURCE",
            quantityCheck.reason ?? "Invalid source quantity",
            400,
          );
        }
      }
      break;
    case "manual_allocation":
      assertValidSource(store.db, input.payload.source);
      {
        const dimensionRows = [
          ...sourceDimensions(store.db, input.payload.source),
          ...strategyDimensions(store.db, input.payload.strategyId),
          ...input.payload.allocations.flatMap((allocation) =>
            executionDimensions(store.db, allocation.executionKey),
          ),
        ];
        const dimensions = new Set(
          dimensionRows.map(
            ({ account, currency }) => `${account}\u0000${currency}`,
          ),
        );
        if (dimensions.size > 1) {
          throw new AppError(
            "INCOMPATIBLE_STRATEGY_MEMBERSHIP",
            `Strategy ${input.payload.strategyId} cannot include evidence from a different account or currency.`,
            409,
          );
        }
      }
      {
        const allocationCheck = validateAllocationsAgainstExistingDecisions(
          store.db,
          input.payload.source,
          input.payload.strategyId,
          input.supersedesId,
        );
        if (!allocationCheck.ok) {
          throw new AppError(
            "ALLOCATION_CONFLICT",
            allocationCheck.reason ?? "Allocation conflict",
            409,
          );
        }
      }
      break;
    case "group_explicit":
      assertValidSource(store.db, input.payload.source);
      assertCompatibleStrategyMembership(
        store.db,
        input.payload.source,
        input.payload.strategyId,
      );
      break;
    case "group_merge":
      assertCompatibleStrategyMerge(
        store.db,
        input.payload.chosenStrategyId,
        input.payload.mergedStrategyIds,
      );
      break;
    case "lifecycle":
      assertValidSource(store.db, input.payload.sourceRef);
      assertValidSource(store.db, input.payload.targetRef);
      break;
    default:
      break;
  }
}

/**
 * Appends a retained user decision. The expectedWatermark argument is the
 * current high-water mark observed by the caller; if the database has moved on
 * the call rejects with STALE_INPUT rather than racing the queue. Decisions
 * are immutable, and a reversal is recorded by appending a new decision that
 * supersedes the earlier one. Duplicate requests (same clientRequestId)
 * return the original decision without writing again.
 */
export async function appendDecision(
  store: Store,
  rawInput: unknown,
  expectedWatermark: number,
): Promise<Decision> {
  if (
    typeof rawInput === "object" &&
    rawInput !== null &&
    "kind" in rawInput &&
    typeof rawInput.kind === "string" &&
    !(DECISION_KINDS as readonly string[]).includes(rawInput.kind)
  ) {
    throw new AppError(
      "INVALID_KIND",
      `Unknown decision kind: ${rawInput.kind}`,
      400,
    );
  }
  const parsed = DecisionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new AppError(
      "INVALID_INPUT",
      `Decision input failed validation: ${parsed.error.message}`,
      400,
    );
  }
  const input = parsed.data;
  return write(store, () => {
    const current = decisionWatermark(store);
    if (current !== expectedWatermark) {
      throw new AppError(
        "STALE_INPUT",
        `Expected watermark ${expectedWatermark} but current watermark is ${current}.`,
        409,
      );
    }
    const existing = store.db
      .prepare(`SELECT id, sequence FROM decisions WHERE client_request_id = ?`)
      .get(input.clientRequestId) as
      | { id: string; sequence: number }
      | undefined;
    if (existing !== undefined) {
      const row = store.db
        .prepare(
          `SELECT id, sequence, kind, source_refs_json, strategy_ids_json,
                  payload_json, supersedes_id, client_request_id, author, created_at
           FROM decisions WHERE id = ?`,
        )
        .get(existing.id) as DecisionRow;
      return readDecisionRow(row);
    }
    validateDecisionInput(store, input, current);
    if (
      input.kind.startsWith("lifecycle_") ||
      input.kind.startsWith("wheel_")
    ) {
      const build = readActiveBuild(store.db);
      if (!build)
        throw new AppError(
          "LIFECYCLE_REBUILD_REQUIRED",
          "Rebuild before editing lifecycles.",
          409,
        );
      const projection = loadProjection(store.db, build.id);
      if (!projection.lifecycles)
        throw new AppError(
          "LIFECYCLE_REBUILD_REQUIRED",
          "Rebuild before editing lifecycles.",
          409,
        );
      if (
        retainedNormalizationInputsChanged(
          store,
          build.ledger_build_id,
          current,
          LEDGER_PARSER_VERSION,
        )
      )
        throw new AppError(
          "STALE_INPUT",
          "Rebuild after import changes before editing lifecycles.",
          409,
        );
      const ledger = loadLedgerSnapshot(store.db, build.ledger_build_id);
      const prior = effectiveDecisions(readDecisions(store, current)).filter(
        (d) => d.id !== input.supersedesId,
      );
      const origins = groupStrategies(
        ledger,
        prior.filter((d) => d.kind !== "group_merge"),
        (account, openingKeys) =>
          findStrategyId(store, { account, openingKeys }) ??
          strategyAnchorKey({ account, openingKeys }),
      );
      validateLifecycleDecision(
        ledger,
        projection,
        prior,
        {
          id: "__validate__",
          sequence: current + 1,
          kind: input.kind,
          payload: input.payload,
          sources: input.sources,
          strategyIds: input.strategyIds,
          supersedesId: input.supersedesId,
        },
        origins,
        readLifecycleAnchors(store.db),
      );
    }
    const id = randomUUID();
    const sequence = current + 1;
    store.db
      .prepare(
        `INSERT INTO decisions (
           id, sequence, kind, source_refs_json, strategy_ids_json,
           payload_json, supersedes_id, client_request_id, author, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sequence,
        input.kind,
        JSON.stringify(input.sources),
        JSON.stringify(input.strategyIds),
        JSON.stringify(input.payload),
        input.supersedesId,
        input.clientRequestId,
        input.author,
        new Date().toISOString(),
      );
    const row = store.db
      .prepare(
        `SELECT id, sequence, kind, source_refs_json, strategy_ids_json,
                payload_json, supersedes_id, client_request_id, author, created_at
         FROM decisions WHERE id = ?`,
      )
      .get(id) as DecisionRow;
    return readDecisionRow(row);
  });
}

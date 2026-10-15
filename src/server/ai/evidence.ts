import { createHash } from "node:crypto";
import type { Execution, Id, SourceRef } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { activeLedgerSnapshot, activeProjection } from "../builds/service.js";
import type { Store } from "../storage/database.js";

/**
 * Bounded evidence snapshots for local analysis.
 *
 * Analysis never hands the model the whole ledger. A snapshot is a fixed,
 * content-hashed set of the ledger rows referenced by the selected review
 * issues (or the whole bounded ledger when no issue is named). Each row keeps
 * the stable `SourceRef` and execution key it came from, so a proposal made in
 * one batch can be validated against a reference read in another: the tools
 * resolve against the whole snapshot, never a page of it.
 */
export const MAX_EVIDENCE_ROWS = 2000;
export const MAX_EVIDENCE_ROWS_PER_BATCH = 50;
/** A single row larger than this is rejected for manual review, never truncated. */
export const MAX_EVIDENCE_ROW_BYTES = 8 * 1024;
/** A read tool's serialized payload is capped at this many UTF-8 bytes. */
export const MAX_READ_PAYLOAD_BYTES = 64 * 1024;

export interface EvidenceRow {
  readonly sourceRef: SourceRef;
  readonly executionKey: string;
  readonly account: string;
  readonly date: string;
  readonly symbol: string;
  readonly assetClass: string;
  readonly quantity: string;
  readonly price: string | null;
  readonly currency: string;
  readonly netCash: string;
  /** Broker-reported amounts; a non-null brokerPnl marks a closing trade. */
  readonly proceeds: string | null;
  readonly commission: string | null;
  readonly basis: string | null;
  readonly brokerPnl: string | null;
  readonly event: string;
  readonly action: string;
  readonly rowHash: string;
}

export interface RejectedEvidenceRow {
  readonly executionKey: string;
  readonly bytes: number;
  readonly reason: string;
}

export interface EvidenceSnapshot {
  readonly buildId: Id;
  readonly ledgerId: Id;
  readonly watermark: number;
  readonly issueKeys: readonly string[];
  readonly rows: readonly EvidenceRow[];
  readonly rejected: readonly RejectedEvidenceRow[];
  readonly contentHash: string;
  readonly producedAt: string;
}

export interface EvidenceInput {
  readonly buildId: Id;
  readonly issueKeys?: readonly string[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Deterministic single-line JSON for hashing: object keys sorted at every level. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function executionRow(execution: Execution): EvidenceRow {
  const sourceRef = execution.sources[0] ?? null;
  if (sourceRef === null) {
    throw new AppError(
      "EVIDENCE_SOURCE_MISSING",
      `Execution ${execution.key} has no source reference.`,
      500,
    );
  }
  const base = {
    sourceRef,
    executionKey: execution.key,
    account: execution.account,
    date: execution.date,
    symbol: execution.instrument.symbol,
    assetClass: execution.instrument.assetClass,
    quantity: execution.quantity,
    price: execution.price,
    currency: execution.currency,
    netCash: execution.netCash,
    proceeds: execution.proceeds,
    commission: execution.commission,
    basis: execution.basis,
    brokerPnl: execution.brokerPnl,
    event: execution.event,
    action: execution.action,
  };
  return { ...base, rowHash: sha256(canonical(base)) };
}

function referencedExecutionKeys(
  executions: readonly Execution[],
  issues: readonly { key: string; sources: SourceRef[] }[],
  issueKeys: readonly string[],
): Set<string> | null {
  if (issueKeys.length === 0) return null;
  const wanted = new Set(issueKeys);
  const sources: SourceRef[] = [];
  for (const issue of issues) {
    if (wanted.has(issue.key)) sources.push(...issue.sources);
  }
  const pairs = new Set(sources.map((s) => `${s.importId}#${s.rowNumber}`));
  const keys = new Set<string>();
  for (const execution of executions) {
    if (
      execution.sources.some((s) => pairs.has(`${s.importId}#${s.rowNumber}`))
    ) {
      keys.add(execution.key);
    }
  }
  return keys;
}

/**
 * Builds an immutable evidence snapshot from the active build. The build id in
 * the input must match the active generation; a mismatched or absent build is a
 * stale request the caller must rebuild before analysing.
 */
export function buildEvidenceSnapshot(
  store: Store,
  input: EvidenceInput,
): EvidenceSnapshot {
  const active = activeProjection(store);
  if (active.buildId === null) {
    throw new AppError(
      "NO_ACTIVE_BUILD",
      "No active build is available to analyse.",
      409,
    );
  }
  if (active.buildId !== input.buildId) {
    throw new AppError(
      "STALE_BUILD",
      "The requested build is not the active build.",
      409,
    );
  }
  const ledger = activeLedgerSnapshot(store);
  if (ledger === null) {
    throw new AppError(
      "NO_ACTIVE_BUILD",
      "No active ledger generation is available to analyse.",
      409,
    );
  }
  const issueKeys = [...(input.issueKeys ?? [])].sort();
  const selected = referencedExecutionKeys(
    ledger.executions,
    active.projection?.issues ?? [],
    issueKeys,
  );

  const rows: EvidenceRow[] = [];
  const rejected: RejectedEvidenceRow[] = [];
  let overflowed = false;
  const executions = [...ledger.executions].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
  for (const execution of executions) {
    if (selected !== null && !selected.has(execution.key)) continue;
    if (rows.length + rejected.length >= MAX_EVIDENCE_ROWS) {
      overflowed = true;
      break;
    }
    const row = executionRow(execution);
    const bytes = Buffer.byteLength(canonical(row), "utf8");
    if (bytes > MAX_EVIDENCE_ROW_BYTES) {
      rejected.push({
        executionKey: execution.key,
        bytes,
        reason: "ROW_TOO_LARGE",
      });
      continue;
    }
    rows.push(row);
  }
  if (overflowed) {
    throw new AppError(
      "EVIDENCE_TOO_LARGE",
      `Evidence exceeds the ${MAX_EVIDENCE_ROWS}-row bound; narrow the review selection.`,
      413,
    );
  }

  const contentHash = sha256(
    canonical({
      buildId: active.buildId,
      ledgerId: ledger.id,
      issueKeys,
      rows,
      rejected,
    }),
  );
  return {
    buildId: active.buildId,
    ledgerId: ledger.id,
    watermark: active.projection?.watermark ?? 0,
    issueKeys,
    rows,
    rejected,
    contentHash,
    producedAt: new Date().toISOString(),
  };
}

/** The next bounded page of rows, capped by both row count and serialized bytes. */
export function selectEvidenceBatch(
  rows: readonly EvidenceRow[],
  offset: number,
  limit: number,
): { readonly rows: readonly EvidenceRow[]; readonly nextOffset: number } {
  const start = Math.max(0, Math.min(offset, rows.length));
  const max = Math.max(1, Math.min(limit, MAX_EVIDENCE_ROWS_PER_BATCH));
  const batch: EvidenceRow[] = [];
  let index = start;
  while (index < rows.length && batch.length < max) {
    const candidate = [...batch, rows[index] as EvidenceRow];
    if (
      Buffer.byteLength(canonical(candidate), "utf8") > MAX_READ_PAYLOAD_BYTES
    ) {
      break;
    }
    batch.push(rows[index] as EvidenceRow);
    index += 1;
  }
  return { rows: batch, nextOffset: index };
}

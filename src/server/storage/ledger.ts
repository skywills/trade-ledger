import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Execution,
  Id,
  Issue,
  LedgerSnapshot,
  RawRow,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { ensureAccount } from "./accounts.js";
import { type Store, write } from "./database.js";

export interface LedgerImportRef {
  id: Id;
  sha256: string;
}

export interface LedgerBuildDraft {
  inputManifestHash: string;
  parserVersion: string;
  revisions: Array<{
    logicalKey: string;
    revisionNumber: number;
    state: string;
    payload: Execution;
    importRowIds: Id[];
  }>;
  lots: Array<{
    importRowId: Id;
    closingReference: string | null;
    openingDatetime: string | null;
    signedQuantity: string;
    basis: string | null;
    reportedPnl: string | null;
  }>;
  issues: Issue[];
}

interface RevisionRow {
  id: string;
  logical_transaction_key: string;
  revision_number: number;
  broker_account: string;
  instrument_json: string;
  broker_ids_json: string;
  event_type: string;
  original_datetime: string | null;
  timezone: string | null;
  signed_quantity: string;
  price: string | null;
  currency: string;
  net_cash: string | null;
  proceeds: string | null;
  commission: string | null;
  taxes: string | null;
  basis: string | null;
  broker_pnl: string | null;
  action: string | null;
  codes_json: string | null;
}

interface SourceRow {
  import_id: string;
  row_number: number;
}

interface LotRow {
  import_id: string;
  row_number: number;
  section: string | null;
  raw_fields_json: string;
  parse_errors_json: string;
}

interface IssueRow {
  stable_issue_key: string;
  code: string;
  severity: string;
  sources_json: string;
}

/**
 * Content hash over the exact normalization inputs: parser version, decision
 * watermark, and the retained identity (id plus content hash) of every
 * included import. Identical inputs produce identical hashes regardless of
 * when the imports were uploaded.
 */
export function manifestHash(
  parserVersion: string,
  decisionWatermark: number,
  imports: ReadonlyArray<LedgerImportRef>,
): string {
  const manifest = {
    // Invalidate retained normalization from before contract evidence/expiry
    // resolution, while preserving the public Flex parser API version.
    normalizationRevision: "contract-lifecycle-v2",
    parserVersion,
    decisionWatermark,
    imports: [...imports]
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
  };
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/**
 * Persists one ledger generation atomically: build metadata, every retained
 * transaction revision with its raw-row provenance, supporting lot details,
 * and the ledger's issues. Account rows are created on first sight so the
 * revision foreign keys always resolve. Runs entirely inside one serialized
 * write transaction.
 */
export async function persistLedgerBuild(
  store: Store,
  draft: LedgerBuildDraft,
): Promise<Id> {
  return write(store, () => {
    const ledgerId = randomUUID();
    store.db
      .prepare(
        `INSERT INTO ledger_builds (
           id, input_manifest_hash, parser_version, status, created_at
         ) VALUES (?, ?, ?, 'complete', ?)`,
      )
      .run(
        ledgerId,
        draft.inputManifestHash,
        draft.parserVersion,
        new Date().toISOString(),
      );

    const insertRevision = store.db.prepare(
      `INSERT INTO transaction_revisions (
         id, ledger_build_id, logical_transaction_key, revision_number, account_id,
         instrument_json, broker_ids_json, trade_id, execution_id, order_id,
         brokerage_order_id, position_action_id, event_type, original_datetime,
         timezone, signed_quantity, price, currency, net_cash, proceeds,
         commission, taxes, basis, broker_pnl, action, codes_json, revision_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertSource = store.db.prepare(
      `INSERT INTO transaction_sources (ledger_build_id, revision_id, import_row_id)
       VALUES (?, ?, ?)`,
    );
    const accountIds = new Map<string, string>();
    const accountIdFor = (brokerAccount: string): string => {
      const cached = accountIds.get(brokerAccount);
      if (cached !== undefined) return cached;
      const id = ensureAccount(store.db, brokerAccount);
      accountIds.set(brokerAccount, id);
      return id;
    };

    for (const revision of draft.revisions) {
      const revisionId = randomUUID();
      const payload = revision.payload;
      insertRevision.run(
        revisionId,
        ledgerId,
        revision.logicalKey,
        revision.revisionNumber,
        accountIdFor(payload.account),
        JSON.stringify(payload.instrument),
        JSON.stringify(payload.brokerIds),
        payload.brokerIds.TradeID ?? null,
        payload.brokerIds.IBExecID ?? null,
        payload.brokerIds.IBOrderID ?? null,
        payload.brokerIds.BrokerageOrderID ?? null,
        payload.brokerIds.PositionActionID ?? null,
        payload.event,
        payload.rawDateTime,
        payload.timezone,
        payload.quantity,
        payload.price,
        payload.currency,
        payload.netCash,
        payload.proceeds,
        payload.commission,
        payload.taxes,
        payload.basis,
        payload.brokerPnl,
        payload.action,
        JSON.stringify(payload.codes),
        revision.state,
      );
      for (const importRowId of revision.importRowIds) {
        insertSource.run(ledgerId, revisionId, importRowId);
      }
    }

    const insertLot = store.db.prepare(
      `INSERT INTO lot_details (
         id, ledger_build_id, import_row_id, closing_reference,
         opening_datetime, signed_lot_quantity, basis, reported_pnl
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const lot of draft.lots) {
      insertLot.run(
        randomUUID(),
        ledgerId,
        lot.importRowId,
        lot.closingReference,
        lot.openingDatetime,
        lot.signedQuantity,
        lot.basis,
        lot.reportedPnl,
      );
    }

    const insertIssue = store.db.prepare(
      `INSERT INTO ledger_issues (
         ledger_build_id, stable_issue_key, code, severity, sources_json
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const issue of [...draft.issues].sort((left, right) =>
      left.key < right.key ? -1 : 1,
    )) {
      insertIssue.run(
        ledgerId,
        issue.key,
        issue.code,
        issue.severity,
        JSON.stringify(issue.sources),
      );
    }

    return ledgerId;
  });
}

function executionFromRow(row: RevisionRow, sources: SourceRow[]): Execution {
  const rawDateTime = row.original_datetime ?? "";
  return {
    key: row.logical_transaction_key,
    account: row.broker_account,
    instrument: JSON.parse(row.instrument_json) as Execution["instrument"],
    date: rawDateTime.slice(0, 10),
    rawDateTime,
    timezone: row.timezone,
    quantity: row.signed_quantity,
    price: row.price,
    currency: row.currency,
    netCash: row.net_cash ?? "",
    proceeds: row.proceeds,
    commission: row.commission,
    taxes: row.taxes,
    basis: row.basis,
    brokerPnl: row.broker_pnl,
    action: (row.action ?? "unknown") as Execution["action"],
    event: row.event_type as Execution["event"],
    brokerIds: JSON.parse(row.broker_ids_json) as Execution["brokerIds"],
    codes: JSON.parse(row.codes_json ?? "[]") as string[],
    sources: sources.map((source) => ({
      importId: source.import_id,
      rowNumber: source.row_number,
    })),
  };
}

/**
 * Reconstructs the immutable snapshot of one ledger generation from the
 * retained evidence tables. Only unambiguous current revisions (the head of
 * each logical chain whose state is active) surface as executions; conflicts
 * and quarantine evidence remain visible as issues.
 */
export function loadLedgerSnapshot(
  db: Database.Database,
  ledgerId: Id,
): LedgerSnapshot {
  const build = db
    .prepare("SELECT id, input_manifest_hash FROM ledger_builds WHERE id = ?")
    .get(ledgerId) as { id: string; input_manifest_hash: string } | undefined;
  if (build === undefined) {
    throw new AppError(
      "LEDGER_NOT_FOUND",
      `No ledger build exists for id ${ledgerId}.`,
      404,
    );
  }

  const revisionRows = db
    .prepare(
      `SELECT r.*, a.broker_account_id AS broker_account
       FROM transaction_revisions r
       JOIN accounts a ON a.id = r.account_id
       WHERE r.ledger_build_id = ?
         AND r.revision_state = 'active'
         AND r.revision_number = (
           SELECT MAX(head.revision_number) FROM transaction_revisions head
           WHERE head.ledger_build_id = r.ledger_build_id
             AND head.logical_transaction_key = r.logical_transaction_key
         )
       ORDER BY r.logical_transaction_key`,
    )
    .all(ledgerId) as RevisionRow[];
  const sourcesStatement = db.prepare(
    `SELECT i.import_id, i.row_number
     FROM transaction_sources s
     JOIN import_rows i ON i.id = s.import_row_id
     WHERE s.ledger_build_id = ? AND s.revision_id = ?
     ORDER BY i.import_id, i.row_number`,
  );

  const executions = revisionRows.map((row) =>
    executionFromRow(
      row,
      sourcesStatement.all(ledgerId, row.id) as SourceRow[],
    ),
  );

  const lotRows = db
    .prepare(
      `SELECT i.import_id, i.row_number, i.section, i.raw_fields_json, i.parse_errors_json
       FROM lot_details ld
       JOIN import_rows i ON i.id = ld.import_row_id
       WHERE ld.ledger_build_id = ?
       ORDER BY i.import_id, i.row_number`,
    )
    .all(ledgerId) as LotRow[];
  const lots: RawRow[] = lotRows.map((row) => ({
    rowNumber: row.row_number,
    section: row.section,
    fields: JSON.parse(row.raw_fields_json) as Record<string, string>,
    kind: "lot",
    issues: JSON.parse(row.parse_errors_json) as Issue[],
  }));

  const issueRows = db
    .prepare(
      `SELECT stable_issue_key, code, severity, sources_json
       FROM ledger_issues WHERE ledger_build_id = ?
       ORDER BY stable_issue_key`,
    )
    .all(ledgerId) as IssueRow[];
  const issues: Issue[] = issueRows.map((row) => ({
    key: row.stable_issue_key,
    code: row.code,
    sources: JSON.parse(row.sources_json) as Issue["sources"],
    severity: row.severity as Issue["severity"],
  }));

  const conflicts = db
    .prepare(
      `SELECT COUNT(*) AS count FROM ledger_issues
       WHERE ledger_build_id = ? AND code = 'identity_conflict'`,
    )
    .get(ledgerId) as { count: number };

  return {
    id: build.id,
    inputHash: build.input_manifest_hash,
    executions,
    lots,
    issues,
    conflicts: conflicts.count,
  };
}

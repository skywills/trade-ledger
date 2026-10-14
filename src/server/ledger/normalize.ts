import type {
  Id,
  Issue,
  LedgerSnapshot,
  RawRow,
  SourceRef,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import {
  canonicalDecimal,
  normalizeExecution,
  normalizeTimestamp,
} from "../imports/normalization.js";
import type { Store } from "../storage/database.js";
import {
  type LedgerBuildDraft,
  loadLedgerSnapshot,
  manifestHash,
  persistLedgerBuild,
} from "../storage/ledger.js";
import {
  type Candidate,
  type IdentityBinding,
  resolveIdentities,
} from "./identity.js";
import { applyRevisions } from "./revisions.js";

export const LEDGER_PARSER_VERSION = "flex-v1";

export interface NormalizeLedgerOptions {
  parserVersion: string;
  decisionWatermark: number;
}

interface ImportMeta {
  id: Id;
  sha256: string;
  timezone: string | null;
}

interface RowRecord {
  id: Id;
  importId: Id;
  rowNumber: number;
  section: string | null;
  fields: Record<string, string>;
  kind: RawRow["kind"];
  issues: Issue[];
}

interface CommittedImportRow {
  id: string;
  sha256: string;
  capability_json: string;
}

interface CommittedRowRecord {
  id: string;
  import_id: string;
  row_number: number;
  section: string | null;
  raw_fields_json: string;
  row_kind: string;
  parse_errors_json: string;
}

interface DecisionRow {
  id: string;
  kind: string;
  payload_json: string;
  supersedes_id: string | null;
}

function readCommittedImports(db: Store["db"]): ImportMeta[] {
  const rows = db
    .prepare(
      `SELECT id, sha256, capability_json FROM imports
       WHERE status = 'committed' ORDER BY id`,
    )
    .all() as CommittedImportRow[];
  return rows.map((row) => {
    let timezone: string | null = null;
    try {
      const capability = JSON.parse(row.capability_json) as {
        timezone?: string | null;
      };
      timezone = capability.timezone ?? null;
    } catch {
      timezone = null;
    }
    return { id: row.id, sha256: row.sha256, timezone };
  });
}

/**
 * Applies the latest nonsuperseded import inclusion/exclusion decision per
 * import within the decision watermark. Raw evidence is never touched: an
 * excluded import only stops contributing to the current generation.
 */
function excludedImportIds(
  db: Store["db"],
  decisionWatermark: number,
): Set<Id> {
  const rows = db
    .prepare(
      `SELECT id, kind, payload_json, supersedes_id FROM decisions
       WHERE sequence <= ? ORDER BY sequence`,
    )
    .all(decisionWatermark) as DecisionRow[];
  const superseded = new Set(
    rows
      .map((row) => row.supersedes_id)
      .filter((id): id is string => id !== null),
  );
  const excluded = new Set<Id>();
  for (const row of rows) {
    if (superseded.has(row.id)) continue;
    // Canonical kinds are `import_exclusion`/`import_inclusion`; the bare legacy
    // aliases are still honoured so previously retained decisions keep working.
    const isExclusion =
      row.kind === "import_exclusion" || row.kind === "exclusion";
    const isInclusion =
      row.kind === "import_inclusion" || row.kind === "reinclusion";
    if (!isExclusion && !isInclusion) continue;
    let importId: string | undefined;
    try {
      const payload = JSON.parse(row.payload_json) as { importId?: string };
      importId = payload.importId;
    } catch {
      importId = undefined;
    }
    if (importId === undefined) continue;
    if (isExclusion) excluded.add(importId);
    else excluded.delete(importId);
  }
  return excluded;
}

/**
 * Reads the latest nonsuperseded identity-binding decisions up to the
 * watermark. These are the retained user resolutions that allow weak rows
 * (no strong broker identity) to merge into one logical transaction.
 */
function readIdentityBindings(
  db: Store["db"],
  decisionWatermark: number,
): IdentityBinding[] {
  const rows = db
    .prepare(
      `SELECT id, kind, payload_json, supersedes_id FROM decisions
       WHERE sequence <= ? ORDER BY sequence`,
    )
    .all(decisionWatermark) as DecisionRow[];
  const superseded = new Set(
    rows
      .map((row) => row.supersedes_id)
      .filter((id): id is string => id !== null),
  );
  const bindings: IdentityBinding[] = [];
  for (const row of rows) {
    if (superseded.has(row.id)) continue;
    if (row.kind !== "identity_binding") continue;
    try {
      const payload = JSON.parse(row.payload_json) as {
        source?: SourceRef;
        canonicalIdentity?: string;
        expectedQuantity?: string;
      };
      if (
        payload.source !== undefined &&
        typeof payload.canonicalIdentity === "string" &&
        payload.canonicalIdentity !== ""
      ) {
        bindings.push({
          source: payload.source,
          canonicalIdentity: payload.canonicalIdentity,
          expectedQuantity: payload.expectedQuantity ?? "",
          decisionId: row.id,
        });
      }
    } catch {
      // A malformed payload is ignored rather than fabricated.
    }
  }
  return bindings;
}

function readCommittedRows(db: Store["db"]): RowRecord[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.import_id, r.row_number, r.section, r.raw_fields_json,
              r.row_kind, r.parse_errors_json
       FROM import_rows r
       JOIN imports i ON i.id = r.import_id
       WHERE i.status = 'committed'
       ORDER BY r.import_id, r.row_number`,
    )
    .all() as CommittedRowRecord[];
  return rows.map((row) => ({
    id: row.id,
    importId: row.import_id,
    rowNumber: row.row_number,
    section: row.section,
    fields: JSON.parse(row.raw_fields_json) as Record<string, string>,
    kind: row.row_kind as RawRow["kind"],
    issues: JSON.parse(row.parse_errors_json) as Issue[],
  }));
}

function lotDraft(row: RowRecord): LedgerBuildDraft["lots"][number] {
  const quantity = canonicalDecimal(row.fields["Quantity"]);
  const signedQuantity =
    quantity.status === "ok"
      ? quantity.value
      : row.fields["Quantity"]?.trim() || "0";
  const opening = normalizeTimestamp(row.fields["OpenDateTime"]);
  const openingDatetime =
    opening.status === "ok"
      ? opening.timestamp
      : row.fields["OpenDateTime"]?.trim() || null;
  const basis = canonicalDecimal(row.fields["CostBasis"]);
  const reportedPnl = canonicalDecimal(row.fields["FifoPnlRealized"]);
  return {
    importRowId: row.id,
    closingReference: row.fields["TradeID"]?.trim() || null,
    openingDatetime,
    signedQuantity,
    basis: basis.status === "ok" ? basis.value : null,
    reportedPnl: reportedPnl.status === "ok" ? reportedPnl.value : null,
  };
}

/**
 * Rebuilds one ledger generation from all committed imports and the retained
 * decisions up to the watermark. Only the implemented parser version is
 * accepted; requesting another is refused rather than approximated. The
 * result is deterministic: identical inputs and decisions produce identical
 * financial content, canonical keys, and source references.
 */
export async function normalizeLedger(
  store: Store,
  options: NormalizeLedgerOptions,
): Promise<LedgerSnapshot> {
  if (options.parserVersion !== LEDGER_PARSER_VERSION) {
    throw new AppError(
      "VERSION_UNAVAILABLE",
      `Ledger parser version ${options.parserVersion} is unavailable; this build implements ${LEDGER_PARSER_VERSION}.`,
      400,
    );
  }

  const imports = readCommittedImports(store.db);
  const excluded = excludedImportIds(store.db, options.decisionWatermark);
  const included = imports.filter((entry) => !excluded.has(entry.id));
  const includedIds = new Set(included.map((entry) => entry.id));
  const timezoneByImport = new Map(
    imports.map((entry) => [entry.id, entry.timezone]),
  );

  const candidates: Candidate[] = [];
  const issues: Issue[] = [];
  const lots: LedgerBuildDraft["lots"] = [];

  for (const row of readCommittedRows(store.db)) {
    if (!includedIds.has(row.importId)) continue;
    if (row.kind === "execution") {
      const source: SourceRef = {
        importId: row.importId,
        rowNumber: row.rowNumber,
      };
      const { execution, issues: rowIssues } = normalizeExecution(
        {
          rowNumber: row.rowNumber,
          section: row.section,
          fields: row.fields,
          kind: row.kind,
          issues: row.issues,
        },
        source,
        timezoneByImport.get(row.importId) ?? null,
      );
      issues.push(...rowIssues);
      if (execution !== null) {
        candidates.push({ source, importRowId: row.id, execution });
      }
    } else if (row.kind === "lot") {
      lots.push(lotDraft(row));
    }
  }

  const identity = resolveIdentities(
    candidates,
    readIdentityBindings(store.db, options.decisionWatermark),
  );
  issues.push(...identity.issues);
  const revisionOutcome = applyRevisions(
    identity.transactions.filter((transaction) => !transaction.conflicted),
  );
  issues.push(...revisionOutcome.issues);

  const ledgerId = await persistLedgerBuild(store, {
    inputManifestHash: manifestHash(
      options.parserVersion,
      options.decisionWatermark,
      included,
    ),
    parserVersion: options.parserVersion,
    revisions: revisionOutcome.revisions.map((revision) => ({
      logicalKey: revision.logicalKey,
      revisionNumber: revision.revisionNumber,
      state: revision.state,
      payload: revision.payload,
      importRowIds: revision.importRowIds,
    })),
    lots,
    issues,
  });
  return loadLedgerSnapshot(store.db, ledgerId);
}

/**
 * Reads back one retained ledger generation. Only unambiguous current
 * revisions surface as executions; conflicts and quarantine evidence remain
 * visible as issues and never silently disappear.
 */
export function readLedger(store: Store, ledgerId: Id): LedgerSnapshot {
  return loadLedgerSnapshot(store.db, ledgerId);
}

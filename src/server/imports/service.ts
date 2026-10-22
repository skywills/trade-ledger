import { randomUUID } from "node:crypto";
import type { Id, Issue, ParsedImport, RawRow } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { type Store, write } from "../storage/database.js";
import { DEFAULT_FLEX_LIMIT_BYTES, parseFlex } from "./csv.js";
import {
  contentRelativePath,
  dataFileExists,
  listContentHashes,
  listStagedPreviewIds,
  promoteStagedOriginal,
  readDataFile,
  removeDataFileQuietly,
  stageOriginalBytes,
  stagingRelativePath,
} from "./files.js";

export const FLEX_PARSER_VERSION = "flex-csv-1";
export const IMPORT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

export interface ImportPreviewInput {
  filename: string;
  bytes: Uint8Array;
  timezone: string | null;
}

export interface ImportPreviewCounts {
  total: number;
  executions: number;
  cashTransactions: number;
  lots: number;
  summaries: number;
  markers: number;
  quarantined: number;
}

export interface ImportPreview {
  id: Id;
  hash: string;
  capabilities: string[];
  counts: ImportPreviewCounts;
  issues: Issue[];
  /** False only when parsing found file-level fatal errors; row quarantines never block a commit. */
  committable: boolean;
}

export interface ImportCommitResult {
  importId: Id;
  duplicate: boolean;
}

export interface ImportSummary {
  id: Id;
  filename: string;
  sha256: string;
  originalFilePath: string;
  importedAt: string;
  status: string;
}

export interface ImportRowView {
  id: Id;
  rowNumber: number;
  section: string | null;
  fields: Record<string, string>;
  kind: string;
  issues: Issue[];
}

export interface ImportRowQuery {
  orderBy: "rowNumber" | "section" | "kind";
  direction: "asc" | "desc";
  limit: number;
  offset: number;
}

interface ImportRowRecord {
  id: string;
  row_number: number;
  section: string | null;
  raw_fields_json: string;
  row_kind: string;
  parse_errors_json: string;
}

/**
 * Fixed column allowlist for one import's retained rows. User sort keys select
 * an entry here; they are never interpolated into SQL, and LIMIT/OFFSET remain
 * bound parameters. Quarantined rows are returned like any other so no raw
 * evidence is ever hidden.
 */
const IMPORT_ROW_COLUMN: Record<ImportRowQuery["orderBy"], string> = {
  rowNumber: "row_number",
  section: "section",
  kind: "row_kind",
};

function assertImportExists(store: Store, importId: Id): void {
  const exists = store.db
    .prepare("SELECT 1 FROM imports WHERE id = ?")
    .get(importId);
  if (exists === undefined) {
    throw new AppError(
      "IMPORT_NOT_FOUND",
      `No import exists for id ${importId}.`,
      404,
    );
  }
}

function importRowView(row: ImportRowRecord): ImportRowView {
  return {
    id: row.id,
    rowNumber: row.row_number,
    section: row.section,
    fields: JSON.parse(row.raw_fields_json) as Record<string, string>,
    kind: row.row_kind,
    issues: JSON.parse(row.parse_errors_json) as Issue[],
  };
}

export function readImportRow(
  store: Store,
  importId: string,
  rowNumber: number,
): ImportRowView {
  assertImportExists(store, importId);
  const row = store.db
    .prepare(`SELECT id, row_number, section, raw_fields_json, row_kind, parse_errors_json
    FROM import_rows WHERE import_id = ? AND row_number = ?`)
    .get(importId, rowNumber) as ImportRowRecord | undefined;
  if (!row)
    throw new AppError(
      "IMPORT_ROW_NOT_FOUND",
      "No retained row exists at this import row number.",
      404,
    );
  return importRowView(row);
}

export function listImportRows(
  store: Store,
  importId: Id,
  query: ImportRowQuery,
): { items: ImportRowView[]; total: number } {
  assertImportExists(store, importId);
  const total = (
    store.db
      .prepare("SELECT COUNT(*) AS count FROM import_rows WHERE import_id = ?")
      .get(importId) as { count: number }
  ).count;
  const column = IMPORT_ROW_COLUMN[query.orderBy];
  const direction = query.direction === "desc" ? "DESC" : "ASC";
  const rows = store.db
    .prepare(
      `SELECT id, row_number, section, raw_fields_json, row_kind, parse_errors_json
       FROM import_rows WHERE import_id = ?
       ORDER BY ${column} ${direction}, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(importId, query.limit, query.offset) as ImportRowRecord[];
  const items = rows.map(importRowView);
  return { items, total };
}

/**
 * Crash points simulated only through this test seam. Each hook, when set,
 * throws before the named step completes so tests can verify recovery of the
 * exact on-disk and database state a process death would leave behind.
 */
export interface ImportFaults {
  beforeStageWrite?: () => void;
  afterStageWrite?: () => void;
  beforePromote?: () => void;
  afterPromote?: () => void;
  beforeMarkCommitted?: () => void;
}

export interface ImportServiceOptions {
  faults?: ImportFaults;
  now?: () => Date;
  limitBytes?: number;
}

export interface RecoveryOptions {
  now?: () => Date;
}

interface PreviewMeta {
  capabilities: string[];
  counts: ImportPreviewCounts;
  issues: Issue[];
  committable: boolean;
  timezone: string | null;
  importId?: Id;
}

interface PreviewRecord {
  id: string;
  filename: string;
  sha256: string;
  parser_version: string;
  preview_json: string;
  status: string;
  created_at: string;
  expires_at: string;
}

interface ImportRecord {
  id: string;
  filename: string;
  sha256: string;
  original_file_path: string;
  imported_at: string;
  status: string;
}

function defaultNow(): Date {
  return new Date();
}

function qualifyIssue(issue: Issue, ownerId: Id): Issue {
  const rowNumber = issue.sources[0]?.rowNumber ?? 0;
  return { ...issue, key: `${ownerId}:${rowNumber}:${issue.code}` };
}

const COUNT_KEY_BY_KIND: Record<
  RawRow["kind"],
  Exclude<keyof ImportPreviewCounts, "total">
> = {
  execution: "executions",
  cash: "cashTransactions",
  lot: "lots",
  summary: "summaries",
  marker: "markers",
  quarantine: "quarantined",
};

function countRows(parsed: ParsedImport): ImportPreviewCounts {
  const counts: ImportPreviewCounts = {
    total: parsed.rows.length,
    executions: 0,
    cashTransactions: 0,
    lots: 0,
    summaries: 0,
    markers: 0,
    quarantined: 0,
  };
  for (const row of parsed.rows) counts[COUNT_KEY_BY_KIND[row.kind]] += 1;
  return counts;
}

function hasFileLevelSource(issue: Issue): boolean {
  return issue.sources.some((source) => source.rowNumber === 0);
}

function readPreviewRecord(store: Store, previewId: Id): PreviewRecord {
  const row = store.db
    .prepare("SELECT * FROM import_previews WHERE id = ?")
    .get(previewId) as PreviewRecord | undefined;
  if (row === undefined) {
    throw new AppError(
      "IMPORT_PREVIEW_NOT_FOUND",
      `No import preview exists for id ${previewId}.`,
      404,
    );
  }
  return row;
}

export interface PreviewSummary {
  readonly id: Id;
  readonly filename: string;
  readonly status: string;
  readonly expiresAt: string;
  readonly preview: ImportPreview;
}

/** A staged preview for display; expired or unknown previews are refused. */
export function readPreviewSummary(
  store: Store,
  previewId: Id,
  now: Date = new Date(),
): PreviewSummary {
  const record = readPreviewRecord(store, previewId);
  if (record.status !== "committed" && record.expires_at <= now.toISOString()) {
    throw new AppError(
      "IMPORT_PREVIEW_EXPIRED",
      `Import preview ${previewId} has expired; upload the file again.`,
      410,
    );
  }
  const meta = JSON.parse(record.preview_json) as PreviewMeta;
  return {
    id: record.id,
    filename: record.filename,
    status: record.status,
    expiresAt: record.expires_at,
    preview: {
      id: record.id,
      hash: record.sha256,
      capabilities: meta.capabilities,
      counts: meta.counts,
      issues: meta.issues,
      committable: meta.committable,
    },
  };
}

function sweepExpiredPreviews(store: Store, now: Date): Promise<void> {
  const expired = store.db
    .prepare(
      `SELECT id FROM import_previews
       WHERE status <> 'committed' AND expires_at <= ?`,
    )
    .all(now.toISOString()) as Array<{ id: string }>;
  if (expired.length === 0) return Promise.resolve();
  return write(store, () => {
    const statement = store.db.prepare(
      "DELETE FROM import_previews WHERE id = ? AND status <> 'committed'",
    );
    for (const { id } of expired) statement.run(id);
  }).then(() => {
    for (const { id } of expired) {
      removeDataFileQuietly(store.dataDir, stagingRelativePath(id));
    }
  });
}

/** Discards only uncommitted previews owned by a failed upload request. */
export async function discardImportPreviews(
  store: Store,
  previewIds: readonly Id[],
): Promise<void> {
  if (previewIds.length === 0) return;
  const removed = await write(store, () => {
    const statement = store.db.prepare(
      "DELETE FROM import_previews WHERE id = ? AND status = 'staged' RETURNING id",
    );
    return previewIds.filter((id) => statement.get(id) !== undefined);
  });
  for (const id of removed) {
    removeDataFileQuietly(store.dataDir, stagingRelativePath(id));
  }
}

/**
 * Creates a durable staged preview. Original bytes are written to a
 * hash-independent, preview-id-addressed staging file and fsynced before the
 * preview row is recorded, so a crash at any point is recoverable: the
 * staging file is reclaimed by recovery once no staged preview references it.
 */
export async function previewImport(
  store: Store,
  input: ImportPreviewInput,
  options: ImportServiceOptions = {},
): Promise<ImportPreview> {
  const limitBytes = options.limitBytes ?? DEFAULT_FLEX_LIMIT_BYTES;
  if (input.bytes.byteLength > limitBytes) {
    throw new AppError(
      "IMPORT_TOO_LARGE",
      `Upload of ${input.bytes.byteLength} bytes exceeds the ${limitBytes} byte import limit.`,
      413,
    );
  }

  const parsed = parseFlex(input.bytes, limitBytes);
  const previewId = randomUUID();

  options.faults?.beforeStageWrite?.();
  stageOriginalBytes(store.sourceRoot, previewId, input.bytes);
  options.faults?.afterStageWrite?.();

  const now = (options.now ?? defaultNow)();
  await sweepExpiredPreviews(store, now);

  const meta: PreviewMeta = {
    capabilities: parsed.capabilities,
    counts: countRows(parsed),
    issues: parsed.issues.map((issue) => qualifyIssue(issue, previewId)),
    committable: !parsed.issues.some(hasFileLevelSource),
    timezone: input.timezone,
  };
  const preview: ImportPreview = {
    id: previewId,
    hash: parsed.hash,
    capabilities: meta.capabilities,
    counts: meta.counts,
    issues: meta.issues,
    committable: meta.committable,
  };

  await write(store, () => {
    store.db
      .prepare(
        `INSERT INTO import_previews (
           id, filename, sha256, parser_version, preview_json, status, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, 'staged', ?, ?)`,
      )
      .run(
        previewId,
        input.filename,
        parsed.hash,
        FLEX_PARSER_VERSION,
        JSON.stringify(meta),
        now.toISOString(),
        new Date(now.getTime() + IMPORT_PREVIEW_TTL_MS).toISOString(),
      );
  });
  return preview;
}

/**
 * Commits a staged preview: promote staged bytes to the content-addressed
 * original, insert the import and every raw row in one transaction, then mark
 * the preview committed. Every crash point resumes idempotently — a retried
 * commit either completes the missing step or recognizes the committed
 * original by hash and reports it as a duplicate.
 */
export async function commitImport(
  store: Store,
  previewId: Id,
  options: ImportServiceOptions = {},
): Promise<ImportCommitResult> {
  const record = readPreviewRecord(store, previewId);
  const meta = JSON.parse(record.preview_json) as PreviewMeta;
  if (record.status === "committed") {
    if (meta.importId === undefined) {
      throw new AppError(
        "IMPORT_PREVIEW_CORRUPT",
        `Committed preview ${previewId} does not reference an import.`,
        500,
      );
    }
    return { importId: meta.importId, duplicate: true };
  }

  const now = (options.now ?? defaultNow)();
  if (record.expires_at <= now.toISOString()) {
    throw new AppError(
      "IMPORT_PREVIEW_EXPIRED",
      `Import preview ${previewId} expired at ${record.expires_at}.`,
      410,
    );
  }
  if (!meta.committable) {
    throw new AppError(
      "IMPORT_PREVIEW_NOT_COMMITTABLE",
      "Import preview cannot be committed because parsing produced fatal errors.",
      422,
    );
  }

  options.faults?.beforePromote?.();
  promoteStagedOriginal(store.sourceRoot, record.sha256, previewId);
  options.faults?.afterPromote?.();

  const bytes = readDataFile(store.dataDir, contentRelativePath(record.sha256));
  const parsed = parseFlex(
    bytes,
    // Retained originals already passed the upload limit during preview.
    options.limitBytes ?? bytes.byteLength,
  );
  if (parsed.hash !== record.sha256) {
    throw new AppError(
      "IMPORT_CONTENT_HASH_MISMATCH",
      `Original bytes for ${record.sha256} no longer hash to their recorded digest.`,
      500,
    );
  }

  let importId = "";
  let duplicate = false;
  await write(store, () => {
    const existing = store.db
      .prepare("SELECT id FROM imports WHERE sha256 = ? LIMIT 1")
      .get(record.sha256) as { id: string } | undefined;
    if (existing !== undefined) {
      importId = existing.id;
      duplicate = true;
      return;
    }
    importId = randomUUID();
    store.db
      .prepare(
        `INSERT INTO imports (
           id, filename, sha256, original_file_path, imported_at, report_period, parser_version, status, capability_json
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'committed', ?)`,
      )
      .run(
        importId,
        record.filename,
        record.sha256,
        contentRelativePath(record.sha256),
        now.toISOString(),
        FLEX_PARSER_VERSION,
        JSON.stringify({
          capabilities: meta.capabilities,
          timezone: meta.timezone,
        }),
      );
    const insertRow = store.db.prepare(
      `INSERT INTO import_rows (
         id, import_id, row_number, section, raw_fields_json, row_kind, parse_errors_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of parsed.rows) {
      insertRow.run(
        randomUUID(),
        importId,
        row.rowNumber,
        row.section,
        JSON.stringify(row.fields),
        row.kind,
        JSON.stringify(
          row.issues.map((issue) => qualifyIssue(issue, importId)),
        ),
      );
    }
  });

  options.faults?.beforeMarkCommitted?.();

  await write(store, () => {
    store.db
      .prepare(
        "UPDATE import_previews SET status = 'committed', preview_json = ? WHERE id = ?",
      )
      .run(JSON.stringify({ ...meta, importId }), previewId);
  });

  return { importId, duplicate };
}

/**
 * Reclaims crash debris without ever touching committed evidence. Staging
 * bytes are removed only when no live staged preview references them; orphan
 * content files are removed only after checking that no committed import and
 * no live staged preview reference the hash. A committed import whose original
 * file is missing is a corruption error and never removes the import.
 */
export async function recoverImportFiles(
  store: Store,
  options: RecoveryOptions = {},
): Promise<void> {
  const now = (options.now ?? defaultNow)();
  const nowIso = now.toISOString();

  await sweepExpiredPreviews(store, now);

  for (const previewId of listStagedPreviewIds(store.sourceRoot)) {
    const row = store.db
      .prepare("SELECT status, expires_at FROM import_previews WHERE id = ?")
      .get(previewId) as { status: string; expires_at: string } | undefined;
    const keep =
      row !== undefined && row.status === "staged" && row.expires_at > nowIso;
    if (!keep) {
      removeDataFileQuietly(store.dataDir, stagingRelativePath(previewId));
    }
  }

  for (const sha256 of listContentHashes(store.sourceRoot)) {
    const committed = store.db
      .prepare("SELECT 1 FROM imports WHERE sha256 = ? LIMIT 1")
      .get(sha256);
    if (committed !== undefined) continue;
    const staged = store.db
      .prepare(
        `SELECT 1 FROM import_previews
         WHERE sha256 = ? AND status = 'staged' AND expires_at > ? LIMIT 1`,
      )
      .get(sha256, nowIso);
    if (staged === undefined) {
      removeDataFileQuietly(store.dataDir, contentRelativePath(sha256));
    }
  }

  const imports = store.db
    .prepare("SELECT id, sha256, original_file_path FROM imports")
    .all() as Array<{
    id: string;
    sha256: string;
    original_file_path: string;
  }>;
  for (const record of imports) {
    if (record.original_file_path !== contentRelativePath(record.sha256)) {
      throw new AppError(
        "IMPORT_ORIGINAL_CORRUPT",
        `Committed import ${record.id} references a non-canonical original path ${record.original_file_path}.`,
        500,
      );
    }
    if (!dataFileExists(store.dataDir, record.original_file_path)) {
      throw new AppError(
        "IMPORT_ORIGINAL_MISSING",
        `Committed import ${record.id} references a missing original file at ${record.original_file_path}.`,
        500,
      );
    }
  }
}

export function listImports(store: Store): ImportSummary[] {
  const rows = store.db
    .prepare(
      `SELECT id, filename, sha256, original_file_path, imported_at, status
       FROM imports ORDER BY imported_at, id`,
    )
    .all() as ImportRecord[];
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    sha256: row.sha256,
    originalFilePath: row.original_file_path,
    importedAt: row.imported_at,
    status: row.status,
  }));
}

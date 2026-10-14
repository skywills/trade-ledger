import type { Id } from "../../shared/domain.js";
import { decisionWatermark } from "../decisions/service.js";
import { LEDGER_PARSER_VERSION } from "../ledger/normalize.js";
import type { Store } from "../storage/database.js";
import { type LedgerImportRef, manifestHash } from "../storage/ledger.js";

export interface BuildInputs {
  imports: LedgerImportRef[];
  watermark: number;
  hash: string;
}

export interface BuildInputRecord {
  input_hash: string;
  decision_watermark: number;
}

/** The retained identity of every committed import, in stable order. */
export function readCommittedImportRefs(db: Store["db"]): LedgerImportRef[] {
  const rows = db
    .prepare(
      `SELECT id, sha256 FROM imports WHERE status = 'committed' ORDER BY id`,
    )
    .all() as Array<{ id: string; sha256: string }>;
  return rows.map((row) => ({ id: row.id, sha256: row.sha256 }));
}

/**
 * Snapshots the exact normalization inputs of a build: every committed import's
 * retained identity (id plus content hash) and the current decision watermark.
 * The resulting hash is a pure function of those inputs, so identical inputs
 * produce identical hashes regardless of upload timing.
 */
export function snapshotInputs(
  store: Store,
  parserVersion: string = LEDGER_PARSER_VERSION,
): BuildInputs {
  const imports = readCommittedImportRefs(store.db);
  const watermark = decisionWatermark(store);
  return {
    imports,
    watermark,
    hash: manifestHash(parserVersion, watermark, imports),
  };
}

/**
 * True when the current imports and decisions no longer match the inputs the
 * build was computed from. A stale candidate is never activated; a stale active
 * build still reads but reports staleness.
 */
export function inputsChanged(
  store: Store,
  build: BuildInputRecord,
  parserVersion: string = LEDGER_PARSER_VERSION,
): boolean {
  const current = snapshotInputs(store, parserVersion);
  return (
    build.input_hash !== current.hash ||
    build.decision_watermark !== current.watermark
  );
}

export interface RetainedLedger {
  id: Id;
  parserVersion: string;
}

/** The ledger generation referenced by the currently active build, if any. */
export function activeLedgerBuild(db: Store["db"]): RetainedLedger | null {
  const row = db
    .prepare(
      `SELECT b.ledger_build_id AS id, l.parser_version AS parser_version
       FROM app_state s
       JOIN builds b ON b.id = s.active_build_id
       JOIN ledger_builds l ON l.id = b.ledger_build_id
       WHERE s.singleton = 1`,
    )
    .get() as { id: string; parser_version: string } | undefined;
  return row === undefined
    ? null
    : { id: row.id, parserVersion: row.parser_version };
}

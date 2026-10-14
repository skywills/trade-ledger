import type { Id } from "../../shared/domain.js";
import {
  type Decision,
  decisionWatermark,
  effectiveDecisions,
  readDecisions,
} from "../decisions/service.js";
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

interface RetainedLedgerManifestRow {
  input_manifest_hash: string;
  decision_watermark: number | null;
}

/**
 * Returns whether the active retained ledger still reflects the source inputs
 * that normalization consumes. Projection-only decisions (notes, groups,
 * allocations, and similar decisions) are deliberately excluded.
 *
 * Ledger manifests store their source imports but not identity bindings. The
 * earliest build referencing a ledger is its originating full build; verify
 * that watermark against the manifest, then compare effective normalization
 * decisions directly.
 */
export function retainedNormalizationInputsChanged(
  store: Store,
  ledgerId: Id,
  currentWatermark: number,
  parserVersion: string,
): boolean {
  const retained = store.db
    .prepare(
      `SELECT l.input_manifest_hash,
              MIN(b.decision_watermark) AS decision_watermark
       FROM ledger_builds l
       LEFT JOIN builds b ON b.ledger_build_id = l.id
       WHERE l.id = ?
       GROUP BY l.id`,
    )
    .get(ledgerId) as RetainedLedgerManifestRow | undefined;
  if (retained === undefined || retained.decision_watermark === null)
    return true;

  const decisions = readDecisions(store, currentWatermark);
  const imports = readCommittedImportRefs(store.db);
  const retainedWatermark = retained.decision_watermark;
  const historical = readDecisions(store, retainedWatermark);
  if (
    manifestHash(
      parserVersion,
      retainedWatermark,
      includedImports(imports, historical),
    ) !== retained.input_manifest_hash
  ) {
    return true;
  }
  return (
    JSON.stringify(normalizationDecisionInputs(imports, historical)) !==
    JSON.stringify(normalizationDecisionInputs(imports, decisions))
  );
}

function includedImports(
  imports: readonly LedgerImportRef[],
  decisions: readonly Decision[],
): LedgerImportRef[] {
  const excluded = excludedImportIds(decisions);
  return imports.filter((entry) => !excluded.has(entry.id));
}

function normalizationDecisionInputs(
  imports: readonly LedgerImportRef[],
  decisions: readonly Decision[],
): unknown {
  const effective = effectiveDecisions(decisions);
  const excluded = excludedImportIds(effective);
  const bindings: Array<{
    id: string;
    source: { importId: string; rowNumber: number };
    canonicalIdentity: string;
    expectedQuantity: string;
  }> = [];
  for (const decision of effective) {
    if (decision.kind !== "identity_binding") continue;
    try {
      const payload = decision.payload as {
        source?: { importId: string; rowNumber: number };
        canonicalIdentity?: string;
        expectedQuantity?: string;
      };
      if (
        payload.source !== undefined &&
        typeof payload.canonicalIdentity === "string" &&
        payload.canonicalIdentity !== ""
      ) {
        bindings.push({
          id: decision.id,
          source: payload.source,
          canonicalIdentity: payload.canonicalIdentity,
          expectedQuantity: payload.expectedQuantity ?? "",
        });
      }
    } catch {
      // Malformed retained decisions are ignored by normalization as well.
    }
  }
  return {
    imports: imports
      .filter((entry) => !excluded.has(entry.id))
      .map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
    bindings,
  };
}

function excludedImportIds(decisions: readonly Decision[]): Set<Id> {
  const excluded = new Set<Id>();
  for (const decision of effectiveDecisions(decisions)) {
    const isExclusion =
      decision.kind === "import_exclusion" || decision.kind === "exclusion";
    const isInclusion =
      decision.kind === "import_inclusion" || decision.kind === "reinclusion";
    if (!isExclusion && !isInclusion) continue;
    const payload = decision.payload as { importId?: string };
    if (payload.importId === undefined) continue;
    if (isExclusion) excluded.add(payload.importId);
    else excluded.delete(payload.importId);
  }
  return excluded;
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

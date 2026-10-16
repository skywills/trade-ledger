import type { LedgerSnapshot, Projection } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { activeProjection } from "../builds/service.js";
import type { Store } from "../storage/database.js";
import { loadLedgerSnapshot } from "../storage/ledger.js";

export interface AnalyticsSnapshot {
  buildId: string | null;
  ledgerId: string | null;
  stale: boolean;
  generatedAt: string;
  projection: Projection | null;
  ledger: LedgerSnapshot | null;
}
export function readAnalyticsSnapshot(
  store: Store,
  now = new Date(),
): AnalyticsSnapshot {
  return store.db.transaction(() => {
    const active = activeProjection(store);
    const base = {
      buildId: active.buildId,
      stale: active.stale,
      generatedAt: now.toISOString(),
    };
    if (!active.projection)
      return { ...base, ledgerId: null, projection: null, ledger: null };
    const ledgerId = active.projection.ledgerId;
    if (
      !store.db
        .prepare("SELECT id FROM ledger_builds WHERE id = ?")
        .get(ledgerId)
    ) {
      throw new AppError(
        "ANALYTICS_SNAPSHOT_INVALID",
        "The active build's ledger is unavailable.",
        500,
      );
    }
    return {
      ...base,
      ledgerId,
      projection: active.projection,
      ledger: loadLedgerSnapshot(store.db, ledgerId),
    };
  })();
}

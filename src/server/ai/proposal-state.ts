import { AppError } from "../../shared/errors.js";
import { checkBuild } from "../analytics/details.js";
import { readAnalyticsSnapshot } from "../analytics/snapshot.js";
import { decisionWatermark } from "../decisions/service.js";
import type { Store } from "../storage/database.js";

export interface ProposalState {
  buildId: string;
  watermark: number;
}

/** Synchronous so callers may also use this inside a writer transaction. */
export function assertProposalState(store: Store, expected: ProposalState) {
  return store.db.transaction(() => {
    const snapshot = readAnalyticsSnapshot(store);
    if (
      !snapshot.buildId ||
      !snapshot.ledgerId ||
      !snapshot.ledger ||
      !snapshot.projection
    )
      throw new AppError(
        "NO_ACTIVE_BUILD",
        "Rebuild before previewing a correction.",
        409,
      );
    checkBuild(snapshot, expected.buildId);
    const watermark = decisionWatermark(store);
    if (watermark !== expected.watermark || snapshot.stale)
      throw new AppError(
        "STALE_INPUT",
        "Journal inputs changed. Rebuild and refresh evidence before previewing a correction.",
        409,
      );
    return {
      ...snapshot,
      buildId: snapshot.buildId,
      ledgerId: snapshot.ledgerId,
      ledger: snapshot.ledger,
      projection: snapshot.projection,
      watermark,
    };
  })();
}

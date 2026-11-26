import { Decimal } from "decimal.js";
import type { Execution } from "../../shared/domain.js";
import { minorUnit } from "../../shared/money.js";
import type { SplitResult } from "./allocation.js";
import type { BasisAllocation } from "./grouping-basis.js";

/**
 * Derive lot P&L only when proven opening basis explains the broker total.
 * Use the same decimal precision as cash splitting and lifecycle membership:
 * emitting longer repeating fractions would lose digits during partitioning.
 */
export function basisPnlShares(
  close: Execution,
  parts: readonly BasisAllocation[],
  cashShares: readonly SplitResult[],
): Map<string, string> | null {
  if (close.brokerPnl === null || close.basis === null || parts.length < 2)
    return null;
  const cash = new Map(
    cashShares.map((share) => [share.strategyId, share.amount]),
  );
  const ordered = [...parts].sort((a, b) =>
    a.draft.id < b.draft.id ? -1 : a.draft.id > b.draft.id ? 1 : 0,
  );
  const amounts = new Map<string, string>();
  let totalBasis = new Decimal(0);
  let totalPnl = new Decimal(0);
  for (const part of ordered) {
    const proceeds = cash.get(part.draft.id);
    const basis = part.releasedBasis;
    if (basis === undefined || proceeds === undefined) return null;
    const pnl = new Decimal(proceeds).plus(basis);
    amounts.set(part.draft.id, pnl.toFixed());
    totalBasis = totalBasis.plus(basis);
    totalPnl = totalPnl.plus(pnl);
  }
  const tolerance = new Decimal(minorUnit(close.currency));
  const residual = new Decimal(close.brokerPnl).minus(totalPnl);
  if (
    totalBasis.minus(close.basis).abs().gt(tolerance) ||
    residual.abs().gt(tolerance)
  )
    return null;
  // Keep every source digit; place only the small rounding residual on the
  // final strategy in stable ID order, just as proportional splitting does.
  const last = ordered[ordered.length - 1];
  if (last === undefined) return null;
  amounts.set(
    last.draft.id,
    new Decimal(amounts.get(last.draft.id) ?? "0").plus(residual).toFixed(),
  );
  return amounts;
}

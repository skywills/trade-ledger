import { Decimal } from "decimal.js";
import { minorUnit } from "./money.js";

/** One allocation of an execution, possibly a partial slice of it. */
export interface BasisRow {
  quantity: string;
  netCash: string;
  brokerPnl: string | null;
  execution: {
    quantity: string;
    basis: string | null;
    commission: string | null;
  };
}

/** Scale an execution-level amount to this row's share of the execution. */
function slice(amount: string, row: BasisRow): Decimal {
  const total = new Decimal(row.execution.quantity);
  return total.isZero()
    ? new Decimal(0)
    : new Decimal(amount).times(row.quantity).div(total);
}

/**
 * True when the gap between reconstructed (cash) P&L and IBKR's P&L is fully
 * explained by IBKR's own lot cost basis drifting from the fill cash through
 * fee re-rounding (seen as a few cents on SOFI calls). Both must hold:
 * - IBKR is internally consistent: on every closing row its P&L equals the
 *   row's net cash plus IBKR's reported cost basis, to one minor unit;
 * - the gap is no larger than the commissions on these fills, which bounds
 *   any fee re-rounding. A wrong lot match differs by the lots' price
 *   difference, which exceeds the fees, so it stays flagged.
 */
export function explainedByBrokerBasis(
  rows: readonly BasisRow[],
  reconstructedPnl: string,
  brokerPnl: string,
  currency: string,
): boolean {
  const unit = minorUnit(currency);
  const closes = rows.filter(
    (r) => r.brokerPnl !== null && !new Decimal(r.brokerPnl).isZero(),
  );
  if (!closes.length) return false;
  for (const row of closes) {
    if (row.execution.basis === null) return false;
    const expected = new Decimal(row.netCash).plus(
      slice(row.execution.basis, row),
    );
    if (
      expected
        .minus(row.brokerPnl ?? "0")
        .abs()
        .gt(unit)
    )
      return false;
  }
  const fees = rows.reduce(
    (total, row) =>
      row.execution.commission === null
        ? total
        : total.plus(slice(row.execution.commission, row).abs()),
    new Decimal(0),
  );
  return new Decimal(reconstructedPnl)
    .minus(brokerPnl)
    .abs()
    .lte(fees.plus(unit));
}

import { Decimal } from "decimal.js";
import type { Execution } from "../../shared/domain.js";
import type { LifecycleMember } from "../../shared/lifecycles.js";

/**
 * Re-split IBKR's broker P&L for a share close that FIFO divided across
 * lifecycles: each lifecycle's part is its share of the close cash plus its
 * own average opening cost for the shares consumed, as IBKR computes per lot.
 * Cents left between that and the broker total (fee rounding inside IBKR's
 * lot basis) are spread by quantity, so the parts still sum exactly.
 * Returns the pieces unchanged when a lifecycle's cost cannot be read.
 */
export function fifoLotPnl(
  pieces: readonly LifecycleMember[],
  brokerPnl: string | null,
  members: readonly LifecycleMember[],
  exec: ReadonlyMap<string, Execution>,
  instrumentKey: string,
): LifecycleMember[] {
  if (pieces.length < 2 || brokerPnl === null) return [...pieces];
  const unitCost = (lifecycleId: string): Decimal | null => {
    let cash = new Decimal(0);
    let units = new Decimal(0);
    for (const m of members) {
      if (m.lifecycleId !== lifecycleId || m.allocation.role !== "open")
        continue;
      if (exec.get(m.allocation.executionKey)?.instrument.key !== instrumentKey)
        continue;
      cash = cash.plus(m.netCash);
      units = units.plus(new Decimal(m.quantity).abs());
    }
    return units.isZero() ? null : cash.div(units);
  };
  const raw: Decimal[] = [];
  for (const piece of pieces) {
    const unit = unitCost(piece.lifecycleId);
    if (unit === null) return [...pieces];
    raw.push(
      new Decimal(piece.netCash).plus(
        unit.times(new Decimal(piece.quantity).abs()),
      ),
    );
  }
  const total = pieces.reduce(
    (s, p) => s.plus(new Decimal(p.quantity).abs()),
    new Decimal(0),
  );
  const residual = new Decimal(brokerPnl).minus(
    raw.reduce((s, v) => s.plus(v), new Decimal(0)),
  );
  let assigned = new Decimal(0);
  return pieces.map((piece, i) => {
    const last = i === pieces.length - 1;
    const share = last
      ? residual.minus(assigned)
      : residual
          .times(new Decimal(piece.quantity).abs())
          .div(total)
          .toDecimalPlaces(10);
    assigned = assigned.plus(share);
    return {
      ...piece,
      brokerPnl: (raw[i] ?? new Decimal(0)).plus(share).toFixed(),
      // IBKR's per-lot arithmetic, not a proportional estimate.
      estimated: false,
      pnlAttribution: "basis-reconciled" as const,
    };
  });
}

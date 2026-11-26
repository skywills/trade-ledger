import { Decimal } from "decimal.js";
import type { Allocation, Execution } from "../../shared/domain.js";
import type { LifecycleMember } from "../../shared/lifecycles.js";
import { reconcilesWithin } from "../../shared/money.js";

export interface StockLotHolding {
  opening: LifecycleMember;
  remaining: Decimal;
}

/** Debit the reported opening slices only after the complete sale reconciles
 * with the live holdings and any confirmed membership. */
export function consumeReportedStockLots(
  close: Allocation,
  openings: ReadonlyMap<string, StockLotHolding[]>,
  book: ReadonlyMap<string, Decimal>,
  confirmed?: readonly { lifecycleId: string; quantity: string }[],
) {
  if (!close.reportedLots?.length) return undefined;
  const confirmedUnits =
    confirmed &&
    new Map(
      confirmed.map((t) => [t.lifecycleId, new Decimal(t.quantity).abs()]),
    );
  const debits = new Map<StockLotHolding, Decimal>();
  const openingCash = new Map<string, Decimal>();
  const quantities = new Map<string, Decimal>();
  for (const lot of close.reportedLots) {
    const quantity = new Decimal(lot.quantity);
    const holders = (openings.get(lot.executionKey) ?? []).flatMap(
      (holding) => {
        const owner = holding.opening.lifecycleId;
        const held = book.get(owner);
        if (
          !held ||
          held.isZero() ||
          held.isNegative() === quantity.isNegative()
        )
          return [];
        const assigned = quantities.get(owner)?.abs() ?? new Decimal(0);
        const allowed = confirmedUnits
          ? (confirmedUnits.get(owner) ?? new Decimal(0))
          : held.abs();
        const capacity = Decimal.min(
          holding.remaining.minus(debits.get(holding) ?? 0),
          Decimal.min(allowed, held.abs()).minus(assigned),
        );
        return capacity.gt(0) ? [{ holding, capacity }] : [];
      },
    );
    const capacity = holders.reduce(
      (n, h) => n.plus(h.capacity),
      new Decimal(0),
    );
    // A split opening has a unique partition only when the sale consumes all
    // available slices or there is a single possible owner.
    if (
      capacity.lt(quantity.abs()) ||
      (holders.length > 1 && !capacity.eq(quantity.abs()))
    )
      return undefined;
    for (const { holding, capacity } of holders) {
      const opening = holding.opening;
      const units = Decimal.min(quantity.abs(), capacity);
      debits.set(holding, (debits.get(holding) ?? new Decimal(0)).plus(units));
      const signed = quantity.isNegative() ? units.negated() : units;
      quantities.set(
        opening.lifecycleId,
        (quantities.get(opening.lifecycleId) ?? new Decimal(0)).plus(signed),
      );
      const cost = new Decimal(opening.netCash)
        .times(signed.negated())
        .div(opening.quantity);
      openingCash.set(
        opening.lifecycleId,
        (openingCash.get(opening.lifecycleId) ?? new Decimal(0)).plus(cost),
      );
    }
  }
  for (const [holding, units] of debits)
    holding.remaining = holding.remaining.minus(units);
  const targets = [...quantities].map(([lifecycleId, quantity]) => ({
    lifecycleId,
    quantity: quantity.toFixed(),
  }));
  return { targets, openingCash };
}

/**
 * Re-split IBKR's broker P&L for a stock close across lifecycles. Use the
 * cost of the reported opening fills when available. FIFO partitions use the
 * average opening cost of each owner's shares.
 * Cents left between that and the broker total (fee rounding inside IBKR's
 * lot basis) are spread by quantity, so the parts still sum exactly.
 * Returns the pieces unchanged when a lifecycle's cost cannot be read.
 */
export function fifoLotPnl(
  pieces: readonly LifecycleMember[],
  brokerPnl: string | null,
  members: readonly LifecycleMember[],
  exec: ReadonlyMap<string, Execution>,
  close: Execution,
  reportedOpeningCash?: ReadonlyMap<string, Decimal>,
): LifecycleMember[] {
  if (pieces.length < 2 || brokerPnl === null) return [...pieces];
  const costOf = (piece: LifecycleMember): Decimal | null => {
    if (reportedOpeningCash)
      return reportedOpeningCash.get(piece.lifecycleId) ?? null;
    let cash = new Decimal(0);
    let units = new Decimal(0);
    for (const m of members) {
      if (m.lifecycleId !== piece.lifecycleId || m.allocation.role !== "open")
        continue;
      if (
        exec.get(m.allocation.executionKey)?.instrument.key !==
        close.instrument.key
      )
        continue;
      cash = cash.plus(m.netCash);
      units = units.plus(new Decimal(m.quantity).abs());
    }
    return units.isZero()
      ? null
      : cash.div(units).times(new Decimal(piece.quantity).abs());
  };
  const raw: Decimal[] = [];
  for (const piece of pieces) {
    const cost = costOf(piece);
    if (cost === null) return [...pieces];
    raw.push(new Decimal(piece.netCash).plus(cost));
  }
  const total = pieces.reduce(
    (s, p) => s.plus(new Decimal(p.quantity).abs()),
    new Decimal(0),
  );
  const rawTotal = raw.reduce((s, v) => s.plus(v), new Decimal(0));
  if (!reconcilesWithin(rawTotal.toFixed(), brokerPnl, close.currency))
    return [...pieces];
  const residual = new Decimal(brokerPnl).minus(rawTotal);
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

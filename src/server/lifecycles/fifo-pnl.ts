import { Decimal } from "decimal.js";
import type { Allocation, Execution } from "../../shared/domain.js";
import { groupBy } from "../../shared/group-by.js";
import type { LifecycleMember } from "../../shared/lifecycles.js";
import { reconcilesWithin } from "../../shared/money.js";

/** Follow each reported opening fill to its lifecycle. A prior ownership
 * decision may already have used the shares, so check the live inventory. */
export function reportedStockLots(
  close: Allocation,
  members: readonly LifecycleMember[],
  book: ReadonlyMap<string, Decimal>,
) {
  if (!close.reportedLots?.length) return undefined;
  const openings = groupBy(
    members.filter(
      (m) =>
        m.allocation.strategyId === close.strategyId &&
        m.allocation.role === "open",
    ),
    (m) => m.allocation.executionKey,
  );
  const openingCash = new Map<string, Decimal>();
  const quantities = new Map<string, Decimal>();
  for (const lot of close.reportedLots) {
    const quantity = new Decimal(lot.quantity);
    const holders = (openings.get(lot.executionKey) ?? []).flatMap(
      (opening) => {
        const held = book.get(opening.lifecycleId);
        if (
          !held ||
          held.isZero() ||
          held.isNegative() === quantity.isNegative()
        )
          return [];
        const capacity = Decimal.min(
          held.abs(),
          new Decimal(opening.quantity).abs(),
        );
        return [{ opening, capacity }];
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
    for (const { opening, capacity } of holders) {
      const units = Decimal.min(quantity.abs(), capacity);
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
  const targets = [];
  for (const [lifecycleId, quantity] of quantities) {
    const held = book.get(lifecycleId);
    if (
      !held ||
      held.isNegative() === quantity.isNegative() ||
      held.abs().lt(quantity.abs())
    )
      return undefined;
    targets.push({ lifecycleId, quantity: quantity.toFixed() });
  }
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

import { Decimal } from "decimal.js";
import type { Execution } from "../../shared/domain.js";
import { compareExecutionTime } from "../ledger/chronology.js";
import { splitAmount } from "./allocation.js";
import { closingExposure } from "./grouping-close-candidates.js";
import type { GroupingContext } from "./grouping-context.js";
import { sameInstrument } from "./matching.js";
import type { StrategyDraft } from "./projection.js";

export interface FifoPart {
  draft: StrategyDraft;
  quantity: string;
}

/** Earliest opening fill of the closed instrument held by a draft. */
function earliestOpening(
  context: GroupingContext,
  draft: StrategyDraft,
  close: Execution,
): Execution | null | undefined {
  let earliest: Execution | undefined;
  for (const leg of draft.legs) {
    if (
      leg.role !== "open" ||
      !sameInstrument(leg.instrument, close.instrument)
    )
      continue;
    const opening = context.executionByKey.get(leg.executionKey);
    if (opening === undefined) return null;
    if (earliest === undefined) {
      earliest = opening;
      continue;
    }
    const order = compareExecutionTime(opening, earliest);
    if (order === null) return null;
    if (order < 0) earliest = opening;
  }
  return earliest;
}

/**
 * IBKR's default lot matching: a close consumes the earliest open lot first,
 * spilling into the next lot when one is not enough. Applied only after lot
 * references and basis evidence could not decide, and only when the timestamps
 * establish a strict order between every eligible lot. Tied or uncertain lots
 * return undefined so the close stays under review instead of being guessed.
 */
export function fifoCloseAllocation(
  context: GroupingContext,
  close: Execution,
  closeQuantity: string,
  drafts: readonly StrategyDraft[],
): FifoPart[] | undefined {
  const quantity = new Decimal(closeQuantity);
  if (quantity.isZero() || drafts.length < 2) return undefined;
  const lots: {
    draft: StrategyDraft;
    opening: Execution;
    capacity: Decimal;
  }[] = [];
  for (const draft of drafts) {
    const exposure = closingExposure(context, draft, close);
    if (exposure.isZero() || exposure.isNegative() === quantity.isNegative())
      continue;
    const opening = earliestOpening(context, draft, close);
    if (!opening) return undefined;
    // An opening after the close cannot be the lot it closes.
    if (compareExecutionTime(opening, close) !== -1) return undefined;
    lots.push({ draft, opening, capacity: exposure.abs() });
  }
  if (lots.length < 2) return undefined;
  for (const [i, a] of lots.entries())
    for (const b of lots.slice(i + 1)) {
      const order = compareExecutionTime(a.opening, b.opening);
      if (order === null || order === 0) return undefined;
    }
  lots.sort((a, b) => compareExecutionTime(a.opening, b.opening) ?? 0);
  const total = lots.reduce((sum, l) => sum.plus(l.capacity), new Decimal(0));
  if (total.lt(quantity.abs())) return undefined;
  const parts: FifoPart[] = [];
  let remaining = quantity.abs();
  for (const lot of lots) {
    if (remaining.isZero()) break;
    const take = Decimal.min(remaining, lot.capacity);
    parts.push({
      draft: lot.draft,
      quantity: (quantity.isNegative() ? take.negated() : take).toFixed(),
    });
    remaining = remaining.minus(take);
  }
  return parts;
}

export interface FifoLegAmount extends FifoPart {
  netCash: string;
  brokerPnl: string | null;
}

/** Opening cash per unit of the closed instrument held by a draft. */
function unitOpeningCash(
  draft: StrategyDraft,
  close: Execution,
): Decimal | null {
  let cash = new Decimal(0);
  let units = new Decimal(0);
  for (const leg of draft.legs) {
    if (
      leg.role !== "open" ||
      !sameInstrument(leg.instrument, close.instrument)
    )
      continue;
    cash = cash.plus(leg.netCash);
    units = units.plus(new Decimal(leg.quantity).abs());
  }
  return units.isZero() ? null : cash.div(units);
}

/**
 * Close cash is split by quantity. Broker P&L follows IBKR's FIFO arithmetic
 * per lot: that lot's share of the close cash plus its own opening cash for
 * the units consumed. Any cents between that and the broker's reported total
 * (fee rounding inside IBKR's lot basis) are spread by quantity, so the parts
 * always add up to the broker figure exactly.
 */
export function fifoLegAmounts(
  context: GroupingContext,
  close: Execution,
  parts: readonly FifoPart[],
  netCash: string,
  brokerPnl: string | null,
): FifoLegAmount[] {
  void context;
  const split = parts.map((p) => ({
    strategyId: p.draft.id,
    quantity: p.quantity,
  }));
  const cash = splitAmount(netCash, split);
  const cashOf = (id: string) =>
    new Decimal(cash.find((c) => c.strategyId === id)?.amount ?? "0");
  if (parts.length === 1 || brokerPnl === null)
    return parts.map((p) => ({
      ...p,
      netCash: cashOf(p.draft.id).toFixed(),
      brokerPnl,
    }));
  const raw = new Map<string, Decimal>();
  for (const p of parts) {
    const unit = unitOpeningCash(p.draft, close);
    if (unit === null)
      return parts.map((q) => ({
        ...q,
        netCash: cashOf(q.draft.id).toFixed(),
        brokerPnl: null,
      }));
    raw.set(
      p.draft.id,
      cashOf(p.draft.id).plus(unit.times(new Decimal(p.quantity).abs())),
    );
  }
  const rawTotal = [...raw.values()].reduce(
    (sum, v) => sum.plus(v),
    new Decimal(0),
  );
  const residual = splitAmount(
    new Decimal(brokerPnl).minus(rawTotal).toFixed(),
    split,
  );
  return parts.map((p) => ({
    ...p,
    netCash: cashOf(p.draft.id).toFixed(),
    brokerPnl: (raw.get(p.draft.id) ?? new Decimal(0))
      .plus(residual.find((r) => r.strategyId === p.draft.id)?.amount ?? "0")
      .toFixed(),
  }));
}

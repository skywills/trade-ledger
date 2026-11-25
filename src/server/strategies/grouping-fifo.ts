import { Decimal } from "decimal.js";
import type { Execution, LedgerSnapshot } from "../../shared/domain.js";
import { matchesOpeningTime } from "../../shared/execution-chronology.js";
import { reconcilesWithin } from "../../shared/money.js";
import { canonicalDecimal } from "../imports/normalization.js";
import { compareExecutionTime } from "../ledger/chronology.js";
import { splitAmount } from "./allocation.js";
import { closingExposure } from "./grouping-close-candidates.js";
import type { GroupingContext } from "./grouping-context.js";
import { sameInstrument } from "./matching.js";
import type { StrategyDraft } from "./projection.js";
import { type PnlSlice, reconstructPnl } from "./reconstructed-pnl.js";

interface OpenLot {
  draft: StrategyDraft;
  opening: Execution;
  capacity: Decimal;
}

export interface FifoPart {
  draft: StrategyDraft;
  quantity: string;
  lots: Array<{ executionKey: string; quantity: string }>;
}

/** Only use fill-level inventory when it agrees with the strategy's available
 * exposure, which already accounts for reservations and manual allocations. */
function remainingLots(
  context: GroupingContext,
  close: Execution,
  drafts: readonly StrategyDraft[],
): OpenLot[] | undefined {
  const result: OpenLot[] = [];
  const negative = new Decimal(close.quantity).isNegative();
  for (const draft of drafts) {
    const exposure = closingExposure(context, draft, close);
    if (exposure.isZero() || exposure.isNegative() === negative) continue;
    const used = new Map<string, Decimal>();
    for (const leg of draft.legs) {
      if (
        leg.role !== "close" ||
        !sameInstrument(leg.instrument, close.instrument)
      )
        continue;
      for (const slice of leg.basisLots ?? []) {
        used.set(
          slice.executionKey,
          (used.get(slice.executionKey) ?? new Decimal(0)).plus(
            new Decimal(slice.quantity).abs(),
          ),
        );
      }
    }
    const lots: OpenLot[] = [];
    for (const leg of draft.openingLegs) {
      if (!sameInstrument(leg.instrument, close.instrument)) continue;
      const opening = context.executionByKey.get(leg.executionKey);
      if (!opening) return undefined;
      const order = compareExecutionTime(opening, close);
      if (order === null) return undefined;
      if (order > 0) continue;
      const quantity = new Decimal(leg.quantity);
      if (quantity.isNegative() === negative) return undefined;
      const capacity = quantity.abs().minus(used.get(opening.key) ?? 0);
      if (capacity.isNegative()) return undefined;
      if (!capacity.isZero()) lots.push({ draft, opening, capacity });
    }
    const only = lots.length === 1 ? lots[0] : undefined;
    if (only?.capacity.gte(exposure.abs())) only.capacity = exposure.abs();
    else if (
      !lots
        .reduce((sum, lot) => sum.plus(lot.capacity), new Decimal(0))
        .eq(exposure.abs())
    )
      return undefined;
    result.push(...lots);
  }
  return result;
}

type Take = { lot: OpenLot; units: Decimal };

function partsOf(takes: Take[], quantity: Decimal): FifoPart[] {
  const owners = new Map<StrategyDraft, FifoPart>();
  for (const { lot, units } of takes) {
    const signed = quantity.isNegative() ? units.negated() : units;
    const owner = owners.get(lot.draft) ?? {
      draft: lot.draft,
      quantity: "0",
      lots: [],
    };
    owner.quantity = new Decimal(owner.quantity).plus(signed).toFixed();
    owner.lots.push({
      executionKey: lot.opening.key,
      quantity: signed.toFixed(),
    });
    owners.set(lot.draft, owner);
  }
  return [...owners.values()];
}

/** Consume individual fills in chronological order, then coalesce the shares
 * of each strategy. A later fill of an older order has its own FIFO rank. */
export function fifoCloseAllocation(
  context: GroupingContext,
  close: Execution,
  closeQuantity: string,
  drafts: readonly StrategyDraft[],
): FifoPart[] | undefined {
  const quantity = new Decimal(closeQuantity);
  const lots = remainingLots(context, close, drafts);
  if (!lots?.length || quantity.isZero()) return undefined;
  for (const [i, a] of lots.entries()) {
    if (lots.length > 1 && compareExecutionTime(a.opening, close) !== -1)
      return undefined;
    for (const b of lots.slice(i + 1)) {
      const order = compareExecutionTime(a.opening, b.opening);
      if (order === null || order === 0) return undefined;
    }
  }
  lots.sort((a, b) => compareExecutionTime(a.opening, b.opening) ?? 0);
  let remaining = quantity.abs();
  const takes: Take[] = [];
  for (const lot of lots) {
    if (remaining.isZero()) break;
    const units = Decimal.min(remaining, lot.capacity);
    takes.push({ lot, units });
    remaining = remaining.minus(units);
  }
  return remaining.isZero() ? partsOf(takes, quantity) : undefined;
}

type LotRow = LedgerSnapshot["lots"][number];

function matchesOpening(row: LotRow, opening: Execution): boolean {
  const raw = row.fields.OpenDateTime?.trim();
  if (!raw) return false;
  return matchesOpeningTime(opening, {
    rawDateTime: raw,
    timezone: row.fields.TimeZone?.trim() || row.reportTimezone || null,
    sources: row.source ? [row.source] : [],
  });
}

/** Each export can corroborate a close. A disagreement or an incomplete
 * partition stays under review instead of silently reverting to FIFO. */
export function reportedLotAllocation(
  context: GroupingContext,
  close: Execution,
  closeQuantity: string,
  drafts: readonly StrategyDraft[],
  rows: readonly LotRow[],
): FifoPart[] | undefined {
  const lots = remainingLots(context, close, drafts);
  if (!lots) return undefined;
  const quantity = new Decimal(closeQuantity);
  const byReport = new Map<string, Map<OpenLot, Decimal>>();
  for (const row of rows) {
    const matches = lots.filter((lot) => matchesOpening(row, lot.opening));
    const lot = matches[0];
    const parsed = canonicalDecimal(row.fields.Quantity);
    if (matches.length !== 1 || !lot || parsed.status === "invalid")
      return undefined;
    const units =
      parsed.status === "ok" ? new Decimal(parsed.value).abs() : quantity.abs();
    if (units.isZero()) return undefined;
    const report = row.source?.importId ?? "";
    const takes = byReport.get(report) ?? new Map<OpenLot, Decimal>();
    takes.set(lot, (takes.get(lot) ?? new Decimal(0)).plus(units));
    byReport.set(report, takes);
  }
  const combined = new Map<OpenLot, Decimal>();
  for (const report of byReport.values()) {
    for (const [lot, units] of report) {
      const previous = combined.get(lot);
      if ((previous && !previous.eq(units)) || units.gt(lot.capacity))
        return undefined;
      combined.set(lot, units);
    }
  }
  const total = [...combined.values()].reduce(
    (sum, units) => sum.plus(units),
    new Decimal(0),
  );
  if (!total.eq(quantity.abs())) return undefined;
  return partsOf(
    [...combined].map(([lot, units]) => ({ lot, units })),
    quantity,
  );
}

export interface FifoLegAmount extends FifoPart {
  netCash: string;
  brokerPnl: string | null;
  pnlEstimated?: boolean;
}

/** Reconstruct the consumed units using the same trade-proceeds and cashflow
 * rules as closed-strategy P&L, including a manually allocated opening's cash. */
function lotPnl(
  context: GroupingContext,
  close: Execution,
  part: FifoPart,
  closeCash: Decimal,
): Decimal | null {
  const slices: PnlSlice[] = [];
  for (const lot of part.lots) {
    const execution = context.executionByKey.get(lot.executionKey);
    const leg = part.draft.openingLegs.find(
      (leg) => leg.executionKey === lot.executionKey,
    );
    if (!execution || !leg) return null;
    const units = new Decimal(lot.quantity).negated();
    slices.push({
      execution,
      quantity: units.toFixed(),
      netCash: new Decimal(leg.netCash)
        .times(units)
        .div(leg.quantity)
        .toFixed(),
    });
  }
  slices.push({
    execution: close,
    quantity: part.quantity,
    netCash: closeCash.toFixed(),
  });
  const amount = reconstructPnl(slices).value;
  return amount === null ? null : new Decimal(amount);
}

/**
 * Split NetCash by quantity. Compute each lot's realized result from its
 * opening and closing cash, or from trade proceeds and fees for futures.
 * Spread rounding residuals so the allocations conserve the broker total.
 * Unreconciled totals receive explicitly estimated shares.
 */
export function fifoLegAmounts(
  context: GroupingContext,
  close: Execution,
  parts: readonly FifoPart[],
  netCash: string,
  brokerPnl: string | null,
): FifoLegAmount[] {
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
  const estimatedShares = (): FifoLegAmount[] => {
    const shares = new Map(
      splitAmount(brokerPnl, split).map((share) => [
        share.strategyId,
        share.amount,
      ]),
    );
    return parts.map((part) => ({
      ...part,
      netCash: cashOf(part.draft.id).toFixed(),
      brokerPnl: shares.get(part.draft.id) ?? null,
      pnlEstimated: true,
    }));
  };
  const raw = new Map<string, Decimal>();
  for (const p of parts) {
    const amount = lotPnl(context, close, p, cashOf(p.draft.id));
    if (amount === null) return estimatedShares();
    raw.set(p.draft.id, amount);
  }
  const rawTotal = [...raw.values()].reduce(
    (sum, v) => sum.plus(v),
    new Decimal(0),
  );
  if (!reconcilesWithin(rawTotal.toFixed(), brokerPnl, close.currency))
    return estimatedShares();
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

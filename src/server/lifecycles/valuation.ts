import { Decimal } from "decimal.js";
import type { LedgerSnapshot } from "../../shared/domain.js";
import { groupBy } from "../../shared/group-by.js";
import type {
  LifecycleProjection,
  LifecycleValuation,
  ValuationSnapshot,
} from "../../shared/lifecycles.js";
import { latestExecutionBound } from "../ledger/chronology.js";
import { brokerRealized } from "./accounting.js";

export { latestExecutionBound } from "../ledger/chronology.js";

/** The same multiplier determines whether a price can produce a valuation and whether to request one. */
export function valuationMultipliers(ledger: LedgerSnapshot | null) {
  const values = new Map<string, Decimal | null>();
  for (const { instrument } of ledger?.executions ?? []) {
    if (values.has(instrument.key)) continue;
    let value: Decimal | null = null;
    try {
      const multiplier = new Decimal(
        instrument.assetClass === "STK" ? 1 : (instrument.multiplier ?? 0),
      );
      if (multiplier.isFinite() && multiplier.gt(0)) value = multiplier;
    } catch {
      // Older retained instruments may carry a nonnumeric broker multiplier.
    }
    values.set(instrument.key, value);
  }
  return values;
}

export function valueLifecycles(
  ledger: LedgerSnapshot,
  p: LifecycleProjection,
  snapshots: readonly ValuationSnapshot[],
): LifecycleValuation[] {
  const exec = new Map(ledger.executions.map((e) => [e.key, e]));
  const multipliers = valuationMultipliers(ledger);
  const membersByLifecycle = groupBy(p.members, (m) => m.lifecycleId);
  return p.lifecycles.map((l) => {
    const members = membersByLifecycle.get(l.id) ?? [];
    const realized = brokerRealized(ledger, members);
    const base: LifecycleValuation = {
      lifecycleId: l.id,
      asOf: null,
      source: null,
      cashflow: l.cashflow ?? "0",
      realizedBrokerPnl: realized.value,
      unrealizedPnl: null,
      totalPnl: null,
      estimated: true,
      reasons: [],
    };
    if (l.reasons.includes("EVENT_CASH_UNRESOLVED"))
      return { ...base, reasons: ["EVENT_CASH_UNRESOLVED"] };
    // Per the lifecycle spec, unrealized is the residual to broker-realized
    // P/L; for a closed lifecycle it is the reconciliation gap.
    if (l.status === "closed")
      return {
        ...base,
        totalPnl: l.reconstructedPnl,
        unrealizedPnl:
          l.reconstructedPnl !== null && realized.value !== null
            ? new Decimal(l.reconstructedPnl).minus(realized.value).toFixed()
            : null,
        estimated: l.reconstructedPnl === null || realized.estimated,
        reasons: l.reconstructedPnl === null ? l.reasons : realized.reasons,
      };
    const positions = l.positions.filter(
      (position) => !new Decimal(position.quantity).isZero(),
    );
    const marks = (s: ValuationSnapshot, key: string): boolean =>
      s.marks.some((mark) => mark.instrumentKey === key);
    const applicable = [...snapshots]
      .filter(
        (s) =>
          s.account === l.account &&
          s.currency === l.currency &&
          positions.some((position) => marks(s, position.instrumentKey)),
      )
      .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));
    // Prefer the newest snapshot that marks every open position; marks are
    // never combined across timestamps. Without one, the newest applicable
    // snapshot reports which marks are missing.
    const snapshot =
      applicable.find((s) =>
        positions.every((position) => marks(s, position.instrumentKey)),
      ) ?? applicable[0];
    if (!snapshot) return { ...base, reasons: ["VALUATION_UNAVAILABLE"] };
    base.asOf = snapshot.asOf;
    base.source = "manual";
    const latest = members
      .map((m) => exec.get(m.allocation.executionKey))
      .filter((e) => e !== undefined)
      .map(latestExecutionBound);
    if (
      !l.complete ||
      latest.some(
        (t) => !Number.isFinite(t) || t > Date.parse(snapshot.asOf),
      ) ||
      Date.parse(snapshot.asOf) > Date.now()
    )
      return { ...base, reasons: ["VALUATION_HISTORY_INCOMPLETE"] };
    const prices = new Map(
      snapshot.marks.map((m) => [m.instrumentKey, m.price]),
    );
    let total = new Decimal(l.cashflow ?? "0");
    for (const pos of positions) {
      const multiplier = multipliers.get(pos.instrumentKey);
      if (!multiplier)
        return { ...base, reasons: ["VALUATION_MULTIPLIER_UNAVAILABLE"] };
      const mark = prices.get(pos.instrumentKey);
      if (mark === undefined || new Decimal(mark).lt(0))
        return { ...base, reasons: ["VALUATION_MARKS_INCOMPLETE"] };
      total = total.plus(
        new Decimal(pos.quantity).times(multiplier).times(mark),
      );
    }
    return {
      ...base,
      totalPnl: total.toFixed(),
      unrealizedPnl:
        realized.value === null ? null : total.minus(realized.value).toFixed(),
      reasons: realized.reasons,
    };
  });
}

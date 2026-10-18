import { Decimal } from "decimal.js";
import type { Execution, LedgerSnapshot } from "../../shared/domain.js";
import type {
  LifecycleProjection,
  LifecycleValuation,
  ValuationSnapshot,
} from "../../shared/lifecycles.js";
import { normalizeTimestamp } from "../imports/normalization.js";
import { brokerRealized } from "./accounting.js";

/** Latest possible instant without interpreting an unzoned timestamp in the host zone. */
export function latestExecutionBound(execution: Execution): number {
  const raw = execution.rawDateTime.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw))
    return Date.parse(raw.replace(" ", "T"));
  const wall = normalizeTimestamp(raw);
  if (wall.status !== "ok") return Number.NaN;
  const utc = ["UTC", "Etc/UTC", "GMT"].includes(execution.timezone ?? "");
  const local = Date.parse(
    wall.timestamp.includes("T")
      ? `${wall.timestamp}Z`
      : `${wall.date}T23:59:59.999Z`,
  );
  // Legal source zones fit within +/-14 hours. For any other/unknown zone,
  // the retained wall clock must be older than even its latest possible UTC instant.
  return local + (utc ? 0 : 14 * 60 * 60 * 1000);
}
export function valueLifecycles(
  ledger: LedgerSnapshot,
  p: LifecycleProjection,
  snapshots: readonly ValuationSnapshot[],
): LifecycleValuation[] {
  const exec = new Map(ledger.executions.map((e) => [e.key, e]));
  return p.lifecycles.map((l) => {
    const members = p.members.filter((m) => m.lifecycleId === l.id);
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
    if (l.status === "closed")
      return {
        ...base,
        totalPnl: l.reconstructedPnl,
        unrealizedPnl:
          l.reconstructedPnl !== null && realized.value !== null
            ? new Decimal(l.reconstructedPnl).minus(realized.value).toFixed()
            : null,
        estimated: false,
      };
    const positions = l.positions.filter(
      (position) => !new Decimal(position.quantity).isZero(),
    );
    const snapshot = [...snapshots]
      .filter(
        (s) =>
          s.account === l.account &&
          s.currency === l.currency &&
          s.marks.some((mark) =>
            positions.some(
              (position) => position.instrumentKey === mark.instrumentKey,
            ),
          ),
      )
      .sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf))[0];
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
    const marks = new Map(
      snapshot.marks.map((m) => [m.instrumentKey, m.price]),
    );
    let total = new Decimal(l.cashflow ?? "0");
    for (const pos of positions) {
      const instrument = ledger.executions.find(
        (e) => e.instrument.key === pos.instrumentKey,
      )?.instrument;
      const mark = marks.get(pos.instrumentKey);
      const multiplier =
        instrument?.assetClass === "STK" ? "1" : instrument?.multiplier;
      if (
        mark === undefined ||
        !multiplier ||
        !new Decimal(multiplier).gt(0) ||
        new Decimal(mark).lt(0)
      )
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

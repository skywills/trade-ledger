import { Decimal } from "decimal.js";
import type { Allocation, Execution } from "../../shared/domain.js";
import type {
  AllocationRef,
  LifecycleMember,
} from "../../shared/lifecycles.js";
import { compareLifecycleTime } from "./chronology.js";

/** Time first; the date only orders executions whose times cannot be compared. */
export function compareByTime(a: Execution, b: Execution): number {
  return compareLifecycleTime(a, b) ?? a.date.localeCompare(b.date);
}

export interface HeldCall {
  execution: Execution;
  close: Execution | null;
}

/** A close that frees shares for a call sold earlier the same day: a buy-back, or a zero-cash expiry. */
function releasesLater(close: Execution | null, opening: Execution): boolean {
  return (
    close !== null &&
    close.date === opening.date &&
    compareLifecycleTime(close, opening) === 1 &&
    close.instrument.putCall === "C" &&
    (close.event === "trade" ||
      (close.event === "expiry" && new Decimal(close.netCash).isZero()))
  );
}

/** The call held at this opening that is bought back or expires worthless later that day, if any. */
export function rollReleasedCall<T extends HeldCall>(
  opening: Execution,
  calls: readonly T[],
): T | undefined {
  return calls.find(
    (c) =>
      c.execution.key !== opening.key &&
      compareByTime(c.execution, opening) < 0 &&
      releasesLater(c.close, opening),
  );
}

/** The share sale that left a held call's replacement uncovered, if a sale falls at or after the opening that day. */
export function sharesSoldAfter(
  opening: Execution,
  held: HeldCall | undefined,
  lifecycleMembers: readonly LifecycleMember[],
  exec: Map<string, Execution>,
): { executionKey: string } | undefined {
  if (!held?.close || held.close.date !== opening.date) return undefined;
  const sale = lifecycleMembers
    .filter((m) => m.allocation.role === "close")
    .flatMap((m) => {
      const e = exec.get(m.allocation.executionKey);
      return e?.instrument.assetClass === "STK" && e.date === opening.date
        ? [e]
        : [];
    })
    .filter((e) => {
      const order = compareLifecycleTime(e, opening);
      return order === null || order >= 0;
    })
    .sort(compareByTime)[0];
  return sale ? { executionKey: sale.key } : undefined;
}

const underlyingOf = (e: Execution) =>
  e.instrument.underlying ?? e.instrument.symbol;

/** The opening of a long call bought in the same instant on the same underlying: the other leg of a spread. */
export function spreadLeg(
  opening: Execution,
  executions: readonly Execution[],
  allocations: readonly Allocation[],
): AllocationRef | undefined {
  const leg = executions.find(
    (x) =>
      x.key !== opening.key &&
      x.account === opening.account &&
      x.instrument.putCall === "C" &&
      x.action === "open" &&
      new Decimal(x.quantity).gt(0) &&
      underlyingOf(x) === underlyingOf(opening) &&
      compareLifecycleTime(x, opening) === 0,
  );
  const allocation = leg
    ? allocations.find((a) => a.executionKey === leg.key && a.role === "open")
    : undefined;
  return allocation
    ? {
        strategyId: allocation.strategyId,
        executionKey: allocation.executionKey,
        role: "open",
      }
    : undefined;
}

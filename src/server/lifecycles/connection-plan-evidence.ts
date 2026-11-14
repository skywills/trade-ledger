import { Decimal } from "decimal.js";
import type { Execution, Projection } from "../../shared/domain.js";
import type { LifecycleMember } from "../../shared/lifecycles.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import { compareLifecycleTime } from "./chronology.js";

const ASSIGNMENT_LINKS = new Set(["assignment", "exercise"]);

const sameSource = (a: Execution, b: { sources: Execution["sources"] }) =>
  a.sources.some((s) =>
    b.sources.some(
      (t) => s.importId === t.importId && s.rowNumber === t.rowNumber,
    ),
  );

/**
 * IBKR gives each combo leg its own IBOrderID, but the legs' IBExecIDs share
 * their first two dot-separated parts (e.g. `0000f942.6827376f.02.01` and
 * `.03.01`). Undefined when the id is missing or not in that form.
 */
function comboId(e: Execution): string | undefined {
  const parts = e.brokerIds.IBExecID?.split(".");
  return parts && parts.length >= 3 ? parts.slice(0, 2).join(".") : undefined;
}

/**
 * A share sale filled in the same instant as a call buy-back is that combo's
 * stock leg only when it sold exactly the shares the buy-back released, and
 * its execution id does not place it in a different combo. An unrelated sale
 * that happens to share the timestamp must not decide the call's lot; the id
 * check only rejects, so an unreadable id falls back to the quantity check.
 */
function sameCombo(sale: Execution, buyBack: Execution): boolean {
  const released = new Decimal(buyBack.quantity)
    .abs()
    .times(buyBack.instrument.multiplier ?? "0");
  if (!new Decimal(sale.quantity).abs().eq(released)) return false;
  const a = comboId(sale);
  const b = comboId(buyBack);
  return a === undefined || b === undefined || a === b;
}

/**
 * The share lot a call's close actually consumed: the lot IBKR's FIFO gave
 * the shares called away by its assignment, or the shares sold in the same
 * instant as its buy-back (one combo order). Lots are decided on the sale's
 * trade date, not when the call was sold, so this is the call's true lot.
 * Undefined when there is no such sale or it points at more than one lot;
 * this mirrors connectedLotOwner, which moves a sale to its connected call.
 */
export function disposalLot(
  call: { strategyId: string; instrumentKey: string },
  members: readonly LifecycleMember[],
  projection: Projection,
  exec: ReadonlyMap<string, Execution>,
): string | undefined {
  const closes = projection.allocations.flatMap((a) => {
    const e = exec.get(a.executionKey);
    return a.strategyId === call.strategyId &&
      a.role === "close" &&
      e?.instrument.key === call.instrumentKey
      ? [e]
      : [];
  });
  if (!closes.length) return undefined;
  const isShareSale = (e: Execution | undefined, from: Execution) =>
    e?.instrument.assetClass === "STK" &&
    new Decimal(e.quantity).lt(0) &&
    e.account === from.account &&
    e.currency === from.currency &&
    underlyingSymbol(e.instrument) === underlyingSymbol(from.instrument);
  const sales = new Set<string>();
  for (const close of closes) {
    if (close.event === "trade" && new Decimal(close.quantity).gt(0)) {
      for (const e of exec.values())
        if (
          isShareSale(e, close) &&
          compareLifecycleTime(e, close) === 0 &&
          sameCombo(e, close)
        )
          sales.add(e.key);
      continue;
    }
    for (const link of projection.links) {
      if (!ASSIGNMENT_LINKS.has(link.type) || link.from !== call.strategyId)
        continue;
      if (!sameSource(close, link)) continue;
      for (const a of projection.allocations) {
        const e = exec.get(a.executionKey);
        if (
          a.strategyId === link.to &&
          a.role === "close" &&
          e &&
          isShareSale(e, close) &&
          sameSource(e, link)
        )
          sales.add(e.key);
      }
    }
  }
  const owners = new Set(
    members
      .filter(
        (m) =>
          m.allocation.role === "close" && sales.has(m.allocation.executionKey),
      )
      .map((m) => m.lifecycleId),
  );
  return owners.size === 1 ? [...owners][0] : undefined;
}

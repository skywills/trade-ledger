import { Decimal } from "decimal.js";
import type {
  Execution,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import type { LifecycleMember } from "../../shared/lifecycles.js";
import { reconcilesWithin } from "../../shared/money.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import { validateLifecycle } from "../strategies/lifecycle.js";

function references(
  sources: Execution["sources"],
  execution: Execution,
): boolean {
  return sources.some((s) =>
    execution.sources.some(
      (t) => s.importId === t.importId && s.rowNumber === t.rowNumber,
    ),
  );
}

interface Delivery {
  execution: Execution;
  quantity: Decimal;
  netCash: Decimal;
}

/** Remove only recorded, proportionally owned charges; never add basis or P&L. */
function principalCash(
  execution: Execution,
  quantity: Decimal,
  netCash: Decimal,
): Decimal {
  const charges = new Decimal(execution.commission ?? "0").plus(
    execution.taxes ?? "0",
  );
  return netCash.minus(charges.times(quantity).div(execution.quantity));
}

function hasDeliveryCash(
  option: Execution,
  slices: readonly LifecycleMember[],
  delivery: Delivery,
): boolean {
  const strike = option.instrument.strike;
  if (strike === null || new Decimal(strike).isNegative()) return false;
  const optionQuantity = slices.reduce(
    (total, member) => total.plus(member.quantity),
    new Decimal(0),
  );
  const optionCash = slices.reduce(
    (total, member) => total.plus(member.netCash),
    new Decimal(0),
  );
  // The strike principal may be booked on either leg. Quantity/provenance,
  // a nonzero fee, price, or reported proceeds alone cannot establish cash.
  const actual = principalCash(option, optionQuantity, optionCash).plus(
    principalCash(delivery.execution, delivery.quantity, delivery.netCash),
  );
  const expected = delivery.quantity.times(strike).negated();
  return (
    actual.cmp(0) === expected.cmp(0) &&
    reconcilesWithin(actual.toFixed(), expected.toFixed(), option.currency)
  );
}

/** Quantity closure alone does not establish where assignment/exercise cash went. */
export function unresolvedEventCash(
  ledger: LedgerSnapshot,
  strategies: Projection,
  members: readonly LifecycleMember[],
): LifecycleMember[] {
  const executions = new Map(ledger.executions.map((e) => [e.key, e]));
  const owners = new Map<string, Set<string>>();
  for (const allocation of strategies.allocations) {
    const ids = owners.get(allocation.executionKey) ?? new Set<string>();
    ids.add(allocation.strategyId);
    owners.set(allocation.executionKey, ids);
  }
  const events = new Map<string, LifecycleMember[]>();
  for (const member of members) {
    const e = executions.get(member.allocation.executionKey);
    if (
      member.allocation.role !== "close" ||
      e?.instrument.assetClass !== "OPT" ||
      (e.event !== "assignment" && e.event !== "exercise")
    )
      continue;
    const slices = events.get(e.key) ?? [];
    slices.push(member);
    events.set(e.key, slices);
  }
  const deliveries = new Map<string, Delivery>();
  for (const m of members) {
    const e = executions.get(m.allocation.executionKey);
    if (e?.instrument.assetClass !== "STK") continue;
    const entry = deliveries.get(e.key) ?? {
      execution: e,
      quantity: new Decimal(0),
      netCash: new Decimal(0),
    };
    entry.quantity = entry.quantity.plus(m.quantity);
    entry.netCash = entry.netCash.plus(m.netCash);
    deliveries.set(e.key, entry);
  }
  const matches = [...events].map(([executionKey, slices]) => {
    const option = executions.get(executionKey);
    if (!option?.instrument.multiplier || !option.instrument.putCall)
      return { slices, candidates: [], cashResolved: false };
    const quantity = slices
      .reduce((total, member) => total.plus(member.quantity), new Decimal(0))
      .times(option.instrument.multiplier)
      .times(option.instrument.putCall === "C" ? -1 : 1);
    const candidates = [...deliveries.values()].filter((delivery) => {
      const stock = delivery.execution;
      if (
        stock.account !== option.account ||
        stock.currency !== option.currency ||
        underlyingSymbol(stock.instrument) !==
          underlyingSymbol(option.instrument) ||
        !delivery.quantity.eq(quantity) ||
        validateLifecycle(option.event, option, stock) !== null
      )
        return false;
      const action = option.brokerIds.PositionActionID;
      if (action && action === stock.brokerIds.PositionActionID) return true;
      return strategies.links.some(
        (link) =>
          link.type === option.event &&
          owners.get(executionKey)?.has(link.from) &&
          owners.get(stock.key)?.has(link.to) &&
          (link.sources.length > 0
            ? references(link.sources, option) &&
              references(link.sources, stock)
            : stock.event === option.event && stock.date === option.date),
      );
    });
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    return {
      slices,
      candidates,
      cashResolved:
        candidate !== undefined && hasDeliveryCash(option, slices, candidate),
    };
  });
  // A delivery cannot be independently spent by two events. Ambiguous matches
  // remain unavailable; never choose one just to make the P&L reconcile.
  const uses = new Map<string, number>();
  for (const match of matches)
    for (const candidate of match.candidates)
      uses.set(
        candidate.execution.key,
        (uses.get(candidate.execution.key) ?? 0) + 1,
      );
  return matches
    .filter(
      (match) =>
        !match.cashResolved ||
        uses.get(match.candidates[0]?.execution.key ?? "") !== 1,
    )
    .flatMap((match) => match.slices);
}

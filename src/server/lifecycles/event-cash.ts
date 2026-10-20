import { Decimal } from "decimal.js";
import type {
  Execution,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import type { LifecycleMember } from "../../shared/lifecycles.js";
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
  const deliveries = new Map<
    string,
    { execution: Execution; quantity: Decimal }
  >();
  for (const m of members) {
    const e = executions.get(m.allocation.executionKey);
    if (e?.instrument.assetClass !== "STK") continue;
    const entry = deliveries.get(e.key) ?? {
      execution: e,
      quantity: new Decimal(0),
    };
    entry.quantity = entry.quantity.plus(m.quantity);
    deliveries.set(e.key, entry);
  }
  const matches = [...events].map(([executionKey, slices]) => {
    const option = executions.get(executionKey);
    if (!option?.instrument.multiplier || !option.instrument.putCall)
      return { slices, candidates: [] };
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
    return { slices, candidates };
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
        match.candidates.length !== 1 ||
        uses.get(match.candidates[0]?.execution.key ?? "") !== 1,
    )
    .flatMap((match) => match.slices);
}

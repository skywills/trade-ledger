import type { LedgerSnapshot, Projection } from "../../shared/domain.js";
import { underlyingSymbol } from "../../shared/symbols.js";

export interface PlanScope {
  ledger: LedgerSnapshot;
  projection: Projection;
  origins?: Projection | undefined;
}

/**
 * Narrows the ledger and projections to one account's trades in one underlying.
 *
 * Share coverage never crosses accounts or underlyings, so judging a call
 * against a position gives the same answer on this slice as on the whole
 * ledger, while each hypothetical projection stays small. Nothing here
 * decides coverage; the projection code still does.
 */
export function scopeTo(
  input: PlanScope,
  account: string,
  underlying: string,
): PlanScope {
  const inScope = new Set(
    input.ledger.executions
      .filter(
        (e) =>
          e.account === account &&
          underlyingSymbol(e.instrument) === underlying,
      )
      .map((e) => e.key),
  );
  const narrow = (p: Projection): Projection => {
    const allocations = p.allocations.filter((a) =>
      inScope.has(a.executionKey),
    );
    const strategyIds = new Set(allocations.map((a) => a.strategyId));
    return {
      ...p,
      allocations,
      strategies: p.strategies.filter((s) => strategyIds.has(s.id)),
      links: p.links.filter(
        (l) => strategyIds.has(l.from) || strategyIds.has(l.to),
      ),
    };
  };
  return {
    ledger: {
      ...input.ledger,
      executions: input.ledger.executions.filter((e) => inScope.has(e.key)),
    },
    projection: narrow(input.projection),
    ...(input.origins ? { origins: narrow(input.origins) } : {}),
  };
}

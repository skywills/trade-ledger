import type { Allocation, Instrument } from "../../shared/domain.js";
import { normalizeSymbol, underlyingSymbol } from "../../shared/symbols.js";
import { Money } from "./performance.js";
import type { AnalyticsSnapshot } from "./snapshot.js";

export interface OpenPositionQuery {
  account?: string | undefined;
  currency?: string | undefined;
  underlying?: string | undefined;
  assetClass?: string | undefined;
  instrumentKey?: string | undefined;
}
export interface OpenPositionRow {
  account: string;
  currency: string;
  instrument: Instrument;
  netQuantity: string;
  longQuantity: string;
  shortQuantity: string;
  strategyCount: number;
  lifecycleCount: number;
}
export interface OpenPositionSelection {
  items: OpenPositionRow[];
  unresolved: Array<{
    strategyId: string;
    instrumentKey: string;
    quantity: string;
    reason:
      | "missing_instrument"
      | "missing_account"
      | "conflicting_account"
      | "conflicting_currency";
  }>;
  contributions: Array<{
    account: string;
    currency: string;
    instrumentKey: string;
    strategyId: string;
    quantity: string;
    lifecycleIds: string[];
  }>;
  unscopedUnresolvedCount: number;
}
const allocationKey = (
  a: Pick<Allocation, "strategyId" | "executionKey" | "role">,
) => JSON.stringify([a.strategyId, a.executionKey, a.role]);

/** Remaining projection quantities, attributed by exact allocation evidence. */
export function selectOpenPositions(
  snapshot: AnalyticsSnapshot,
  query: OpenPositionQuery,
): OpenPositionSelection {
  const result: OpenPositionSelection = {
    items: [],
    unresolved: [],
    contributions: [],
    unscopedUnresolvedCount: 0,
  };
  const executions = new Map(
    (snapshot.ledger?.executions ?? []).map((e) => [e.key, e]),
  );
  const allocations = new Map<string, Allocation[]>();
  for (const a of snapshot.projection?.allocations ?? []) {
    const rows = allocations.get(a.strategyId) ?? [];
    rows.push(a);
    allocations.set(a.strategyId, rows);
  }
  const lifecycleRefs = new Map<string, Set<string>>();
  for (const m of snapshot.projection?.lifecycles?.members ?? []) {
    const key = allocationKey(m.allocation);
    const ids = lifecycleRefs.get(key) ?? new Set<string>();
    ids.add(m.lifecycleId);
    lifecycleRefs.set(key, ids);
  }
  const groups = new Map<
    string,
    { row: OpenPositionRow; strategies: Set<string>; lifecycles: Set<string> }
  >();
  for (const strategy of snapshot.projection?.strategies ?? []) {
    const remaining = new Map<string, InstanceType<typeof Money>>();
    for (const p of strategy.positions)
      remaining.set(
        p.instrumentKey,
        (remaining.get(p.instrumentKey) ?? new Money(0)).plus(p.quantity),
      );
    const all = allocations.get(strategy.id) ?? [];
    for (const [instrumentKey, quantity] of remaining) {
      if (quantity.isZero()) continue;
      const matching = all.filter(
        (a) => executions.get(a.executionKey)?.instrument.key === instrumentKey,
      );
      const evidence = matching.flatMap((a) => {
        const e = executions.get(a.executionKey);
        return e ? [e] : [];
      });
      const instrument = evidence[0]?.instrument;
      const accounts = new Set(evidence.map((e) => e.account));
      const currencies = new Set(evidence.map((e) => e.currency));
      const currencyMatches =
        currencies.size === 1 && currencies.has(strategy.currency);
      const account =
        accounts.size === 1 && !accounts.has("")
          ? evidence[0]?.account
          : undefined;
      const reason =
        !instrument || all.some((a) => !executions.has(a.executionKey))
          ? "missing_instrument"
          : !currencyMatches
            ? "conflicting_currency"
            : accounts.size > 1
              ? "conflicting_account"
              : !account?.trim()
                ? "missing_account"
                : null;
      // Unknown attribution cannot satisfy a requested filter; disclose that gap.
      const checks = [
        query.instrumentKey ? query.instrumentKey === instrumentKey : true,
        query.currency
          ? currencyMatches
            ? query.currency === strategy.currency
            : undefined
          : true,
        query.account
          ? account?.trim()
            ? query.account === account
            : undefined
          : true,
        query.assetClass
          ? instrument
            ? query.assetClass === instrument.assetClass
            : undefined
          : true,
        query.underlying
          ? instrument
            ? normalizeSymbol(
                query.underlying.replace(/^value:/, ""),
              ).toUpperCase() === underlyingSymbol(instrument).toUpperCase()
            : undefined
          : true,
      ];
      if (checks.includes(false)) continue;
      if (checks.includes(undefined)) {
        result.unscopedUnresolvedCount++;
        continue;
      }
      if (reason || !instrument || !account) {
        result.unresolved.push({
          strategyId: strategy.id,
          instrumentKey,
          quantity: quantity.toFixed(),
          reason: reason ?? "missing_account",
        });
        continue;
      }
      const lifecycleIds = [
        ...new Set(
          matching.flatMap((a) => [
            ...(lifecycleRefs.get(allocationKey(a)) ?? []),
          ]),
        ),
      ].sort();
      result.contributions.push({
        account,
        currency: strategy.currency,
        instrumentKey,
        strategyId: strategy.id,
        quantity: quantity.toFixed(),
        lifecycleIds,
      });
      const key = JSON.stringify([account, strategy.currency, instrumentKey]);
      const group = groups.get(key) ?? {
        row: {
          account,
          currency: strategy.currency,
          instrument,
          netQuantity: "0",
          longQuantity: "0",
          shortQuantity: "0",
          strategyCount: 0,
          lifecycleCount: 0,
        },
        strategies: new Set<string>(),
        lifecycles: new Set<string>(),
      };
      group.row.netQuantity = new Money(group.row.netQuantity)
        .plus(quantity)
        .toFixed();
      if (quantity.gt(0))
        group.row.longQuantity = new Money(group.row.longQuantity)
          .plus(quantity)
          .toFixed();
      else
        group.row.shortQuantity = new Money(group.row.shortQuantity)
          .plus(quantity.abs())
          .toFixed();
      group.strategies.add(strategy.id);
      for (const id of lifecycleIds) group.lifecycles.add(id);
      groups.set(key, group);
    }
  }
  result.items = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => ({
      ...g.row,
      strategyCount: g.strategies.size,
      lifecycleCount: g.lifecycles.size,
    }));
  result.contributions.sort((a, b) =>
    JSON.stringify([
      a.account,
      a.currency,
      a.instrumentKey,
      a.strategyId,
    ]).localeCompare(
      JSON.stringify([b.account, b.currency, b.instrumentKey, b.strategyId]),
    ),
  );
  result.unresolved.sort((a, b) =>
    JSON.stringify([a.strategyId, a.instrumentKey]).localeCompare(
      JSON.stringify([b.strategyId, b.instrumentKey]),
    ),
  );
  return result;
}

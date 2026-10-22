import type { RealizedPnlSummary } from "../../shared/analytics.js";
import type { Strategy } from "../../shared/domain.js";
import { lifecycleExecutions } from "./lifecycles.js";
import { Money } from "./performance.js";
import type { AnalyticsScope } from "./scope.js";

type Status = "completed" | "open" | "unresolved";
function covered(values: readonly (string | null)[]) {
  const known = values.filter((v): v is string => v !== null);
  const knownValue = known
    .reduce((sum, value) => sum.plus(value), new Money(0))
    .toFixed();
  return {
    value: known.length === values.length ? knownValue : null,
    knownValue,
    known: known.length,
    total: values.length,
  };
}

/** Realized broker amounts follow execution dates, independently of lifecycle completion. */
export function realizedContributions(scope: AnalyticsScope) {
  const executions = new Set(scope.executions.map((e) => e.key));
  const allocations = scope.snapshot.projection?.allocations ?? [];
  const groups = new Map<string, (string | null)[]>();
  for (const allocation of allocations) {
    if (!executions.has(allocation.executionKey)) continue;
    const values = groups.get(allocation.strategyId) ?? [];
    values.push(allocation.brokerPnl);
    groups.set(allocation.strategyId, values);
  }
  return scope.selected.flatMap((strategy) => {
    const values = groups.get(strategy.id);
    if (!values) return [];
    const status: Status =
      !strategy.complete || strategy.status === "unresolved"
        ? "unresolved"
        : strategy.status === "closed"
          ? "completed"
          : "open";
    return [{ strategy, status, values, pnl: covered(values) }];
  });
}

function unallocated(scope: AnalyticsScope) {
  const allocated = new Set(
    (scope.snapshot.projection?.allocations ?? []).map((a) => a.executionKey),
  );
  return scope.executions.filter((e) => !allocated.has(e.key));
}

export function summarizeRealizedPnl(
  scope: AnalyticsScope,
): RealizedPnlSummary {
  const contributions = realizedContributions(scope);
  const values = (status: Status) =>
    contributions.filter((c) => c.status === status).flatMap((c) => c.values);
  const completed = values("completed"),
    open = values("open");
  const unresolved = [
    ...values("unresolved"),
    ...unallocated(scope).map((e) => e.brokerPnl),
  ];
  return {
    completed: covered(completed),
    open: covered(open),
    unresolved: covered(unresolved),
    total: covered(scope.executions.map((e) => e.brokerPnl)),
  };
}

export function realizedLifecycleRows(
  scope: AnalyticsScope,
  status: "open" | "completed",
): Strategy[] {
  return realizedContributions(scope)
    .filter(
      (c) =>
        c.status === status &&
        (c.pnl.value === null || !new Money(c.pnl.value).isZero()),
    )
    .map((c) => ({ ...c.strategy, brokerPnl: c.pnl.value }));
}

export function unresolvedRealizedExecutions(scope: AnalyticsScope) {
  const ids = new Set(
    realizedContributions(scope)
      .filter((c) => c.status === "unresolved")
      .map((c) => c.strategy.id),
  );
  const keys = new Set(
    (scope.snapshot.projection?.allocations ?? [])
      .filter((a) => ids.has(a.strategyId))
      .map((a) => a.executionKey),
  );
  const inPeriod = new Set(scope.executions.map((e) => e.key));
  const sources = (scope.snapshot.ledger?.executions ?? []).filter(
    (e) => keys.has(e.key) && inPeriod.has(e.key),
  );
  return [
    ...lifecycleExecutions(scope.snapshot, ids, sources),
    ...unallocated(scope),
  ];
}

import type {
  AnalyticsQuery,
  AnalyticsResponse,
  GroupRow,
  StrategyResult,
} from "../../shared/analytics.js";
import type { Strategy } from "../../shared/domain.js";
import { normalizeStrategyDescription } from "../../shared/symbols.js";
import { dailySeries, Money, summarizePerformance } from "./performance.js";
import {
  type AnalyticsScope,
  bucketLabel,
  resolveScope,
  selectedPnl,
} from "./scope.js";
import type { AnalyticsSnapshot } from "./snapshot.js";
import { summarizeTransactions } from "./transactions.js";
export function strategyResult(
  s: Strategy,
  scope: AnalyticsScope,
): StrategyResult {
  return {
    ...s,
    description: normalizeStrategyDescription(s.description),
    selectedPnl: selectedPnl(s, scope.query),
    underlying: scope.attribution.get(s.id)?.underlying ?? "__unknown__",
    assetClass: scope.attribution.get(s.id)?.assetClass ?? "__unknown__",
  };
}
function group(
  scope: AnalyticsScope,
  key: string,
  label: string,
  rows: Strategy[],
): GroupRow {
  const p = summarizePerformance({ ...scope, closed: rows, currentOpen: [] });
  return {
    key,
    label,
    closed: p.closed,
    eligible: p.eligible,
    missing: p.missing,
    wins: p.wins,
    losses: p.losses,
    breakeven: p.breakeven,
    pnl: p.pnl,
    winRatePct: p.winRatePct,
  };
}
export function aggregateAnalytics(
  snapshot: AnalyticsSnapshot,
  query: AnalyticsQuery,
): AnalyticsResponse {
  const scope = resolveScope(snapshot, query);
  const performance = summarizePerformance(scope);
  const transactions = summarizeTransactions(scope);
  const breakdown = (dim: "strategyType" | "underlying") => {
    const key = (s: Strategy) =>
      dim === "strategyType"
        ? `value:${s.type}`
        : (scope.attribution.get(s.id)?.underlying ?? "__unknown__");
    return [...new Set(scope.closed.map(key))]
      .map((k) =>
        group(
          scope,
          k,
          bucketLabel(k),
          scope.closed.filter((s) => key(s) === k),
        ),
      )
      .sort((a, b) =>
        a.pnl === null
          ? b.pnl === null
            ? a.key.localeCompare(b.key)
            : 1
          : b.pnl === null
            ? -1
            : new Money(b.pnl).cmp(a.pnl) || a.key.localeCompare(b.key),
      );
  };
  const months = [
    ...new Set([
      ...scope.closed.map((s) => (s.closeDate ?? "").slice(0, 7)),
      ...scope.executions.map((e) => e.date.slice(0, 7)),
    ]),
  ].sort();
  // Bound calendar work by observed endpoints; no dense daily expansion.
  const first = query.from?.slice(0, 7) ?? months[0],
    last = query.to?.slice(0, 7) ?? months.at(-1);
  const filled: string[] = [];
  if (first && last) {
    let y = Number(first.slice(0, 4)),
      m = Number(first.slice(5));
    while (
      `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}` <= last
    ) {
      filled.push(
        `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`,
      );
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
  }
  const monthly = filled.map((month) => {
    const closed = scope.closed.filter((s) =>
      (s.closeDate ?? "").startsWith(month),
    );
    const tx = summarizeTransactions({
      ...scope,
      executions: scope.executions.filter((e) => e.date.startsWith(month)),
    });
    const g = group(scope, month, month, closed);
    return {
      ...g,
      pnl: closed.length ? g.pnl : "0",
      month,
      executions: tx.executions,
      netCash: tx.executions ? tx.netCash : "0",
    };
  });
  const recent = [...scope.closed].sort(
    (a, b) =>
      (b.closeDate ?? "").localeCompare(a.closeDate ?? "") ||
      a.id.localeCompare(b.id),
  );
  const ranked = scope.closed
    .filter((s) => selectedPnl(s, scope.query) !== null)
    .sort(
      (a, b) =>
        new Money(selectedPnl(b, scope.query) ?? "0").cmp(
          selectedPnl(a, scope.query) ?? "0",
        ) ||
        (b.closeDate ?? "").localeCompare(a.closeDate ?? "") ||
        a.id.localeCompare(b.id),
    );
  const eligibleIds = new Set(
    scope.closed
      .filter((s) => selectedPnl(s, scope.query) !== null)
      .map((s) => s.id),
  );
  return {
    buildId: snapshot.buildId,
    ledgerId: snapshot.ledgerId,
    stale: snapshot.stale,
    generatedAt: snapshot.generatedAt,
    filters: scope.query,
    options: scope.options,
    performance,
    transactions,
    daily: dailySeries(scope),
    monthly,
    byStrategyType: breakdown("strategyType"),
    byUnderlying: breakdown("underlying"),
    recent: recent.slice(0, 10).map((s) => strategyResult(s, scope)),
    best: ranked
      .filter((s) => new Money(selectedPnl(s, scope.query) ?? "0").gt(0))
      .slice(0, 10)
      .map((s) => strategyResult(s, scope)),
    worst: [...ranked]
      .sort(
        (a, b) =>
          new Money(selectedPnl(a, scope.query) ?? "0").cmp(
            selectedPnl(b, scope.query) ?? "0",
          ) ||
          (b.closeDate ?? "").localeCompare(a.closeDate ?? "") ||
          a.id.localeCompare(b.id),
      )
      .filter((s) => new Money(selectedPnl(s, scope.query) ?? "0").lt(0))
      .slice(0, 10)
      .map((s) => strategyResult(s, scope)),
    quality: {
      undatedClosed: scope.undatedClosed.length,
      unresolved: scope.unresolved.length,
      estimatedClosed:
        query.basis === "broker"
          ? new Set(
              (snapshot.projection?.allocations ?? [])
                .filter((a) => a.pnlEstimated && eligibleIds.has(a.strategyId))
                .map((a) => a.strategyId),
            ).size
          : 0,
      excludedUnallocated: scope.excludedUnallocated,
    },
  };
}

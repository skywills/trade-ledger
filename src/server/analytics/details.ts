import type {
  AnalyticsDetailsResponse,
  DetailQuery,
} from "../../shared/analytics.js";
import { AppError } from "../../shared/errors.js";
import {
  normalizeUnderlyingKey,
  underlyingSymbol,
} from "../../shared/symbols.js";
import { strategyResult } from "./aggregate.js";
import { Money } from "./performance.js";
import { invalid } from "./query.js";
import { resolveScope, selectedPnl } from "./scope.js";
import type { AnalyticsSnapshot } from "./snapshot.js";
export function checkBuild(
  snapshot: AnalyticsSnapshot,
  expected?: string,
): void {
  if (expected && snapshot.buildId !== expected)
    throw new AppError(
      "ANALYTICS_BUILD_CHANGED",
      "The active build changed. Refresh analytics before continuing.",
      409,
    );
}
export function selectAnalyticsDetails(
  snapshot: AnalyticsSnapshot,
  query: DetailQuery,
): AnalyticsDetailsResponse {
  checkBuild(snapshot, query.expectedBuildId);
  const scope = resolveScope(snapshot, query);
  query = {
    ...query,
    ...scope.query,
    ...(query.groupBy === "underlying" && query.group
      ? { group: normalizeUnderlyingKey(query.group) }
      : {}),
  };
  const meta = {
    buildId: snapshot.buildId,
    ledgerId: snapshot.ledgerId,
    generatedAt: snapshot.generatedAt,
    stale: snapshot.stale,
    page: query.page,
    pageSize: query.pageSize,
    filters: { ...query, currency: scope.query.currency },
  };
  const numeric = new Set(["pnl", "quantity", "netCash"]);
  function compare(a: string | null, b: string | null, key: string) {
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    const cmp = numeric.has(key) ? new Money(a).cmp(b) : a.localeCompare(b);
    return query.direction === "asc" ? cmp : -cmp;
  }
  function validGroup(keys: string[]) {
    if (query.group && !keys.includes(query.group))
      invalid("Group is not present in this snapshot.");
  }
  if (query.kind === "strategies") {
    if (query.groupBy === "strategyType")
      validGroup(scope.options.strategyTypes.map((t) => `value:${t}`));
    if (query.groupBy === "underlying")
      validGroup(scope.options.underlyings.map((x) => x.key));
    if (query.groupBy === "assetClass")
      validGroup([...scope.attribution.values()].map((x) => x.assetClass));
    let rows =
      query.scope === "current-open"
        ? scope.currentOpen
        : query.scope === "unresolved"
          ? scope.unresolved
          : query.scope === "undated-closed"
            ? scope.undatedClosed
            : scope.closed;
    rows = rows.filter((s) => {
      if (query.date && s.closeDate !== query.date) return false;
      if (query.group) {
        const key =
          query.groupBy === "strategyType"
            ? `value:${s.type}`
            : query.groupBy === "underlying"
              ? scope.attribution.get(s.id)?.underlying
              : scope.attribution.get(s.id)?.assetClass;
        if (key !== query.group) return false;
      }
      const p = selectedPnl(s, query);
      if (query.outcome) {
        if (query.outcome === "unavailable") return p === null;
        if (p === null) return false;
        const sign = new Money(p).cmp(0);
        return query.outcome === "win"
          ? sign > 0
          : query.outcome === "loss"
            ? sign < 0
            : sign === 0;
      }
      return true;
    });
    const key = query.sort ?? "closeDate";
    rows.sort(
      (a, b) =>
        compare(
          key === "pnl"
            ? selectedPnl(a, query)
            : key === "id"
              ? a.id
              : a.closeDate,
          key === "pnl"
            ? selectedPnl(b, query)
            : key === "id"
              ? b.id
              : b.closeDate,
          key,
        ) || a.id.localeCompare(b.id),
    );
    return {
      ...meta,
      kind: "strategies",
      total: rows.length,
      items: rows
        .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
        .map((s) => strategyResult(s, scope)),
    };
  }
  if (query.groupBy === "event")
    validGroup([
      ...new Set((snapshot.ledger?.executions ?? []).map((e) => e.event)),
    ]);
  if (query.groupBy === "assetClass") validGroup(scope.options.assetClasses);
  if (query.groupBy === "underlying")
    validGroup(scope.options.underlyings.map((x) => x.key));
  const rows = scope.executions.filter(
    (e) =>
      (!query.date || e.date === query.date) &&
      (!query.group ||
        (query.groupBy === "event"
          ? e.event
          : query.groupBy === "assetClass"
            ? e.instrument.assetClass
            : `value:${underlyingSymbol(e.instrument)}`) === query.group),
  );
  const key = query.sort ?? "date";
  const value = (e: (typeof rows)[number]) =>
    key === "symbol"
      ? e.instrument.symbol
      : key === "quantity"
        ? e.quantity
        : key === "netCash"
          ? e.netCash
          : e.date;
  rows.sort(
    (a, b) => compare(value(a), value(b), key) || a.key.localeCompare(b.key),
  );
  return {
    ...meta,
    kind: "transactions",
    total: rows.length,
    items: rows.slice(
      (query.page - 1) * query.pageSize,
      query.page * query.pageSize,
    ),
  };
}

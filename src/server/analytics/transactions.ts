import type { TransactionSummary } from "../../shared/analytics.js";
import { normalizeSymbol } from "../../shared/symbols.js";
import { sum } from "./performance.js";
import type { AnalyticsScope } from "./scope.js";
export function summarizeTransactions(
  scope: AnalyticsScope,
): TransactionSummary {
  const rows = scope.executions;
  const covered = (key: "commission" | "taxes") => ({
    value: sum(rows.map((e) => e[key])),
    known: rows.filter((e) => e[key] !== null).length,
    total: rows.length,
  });
  const counts = (key: "assetClass" | "event") => {
    const groups = new Map<string, number>();
    for (const e of rows) {
      const k = key === "event" ? e.event : e.instrument.assetClass;
      groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    return [...groups]
      .map(([key, count]) => ({ key, label: key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  };
  return {
    executions: rows.length,
    tradedSymbols: new Set(
      rows.map((e) => normalizeSymbol(e.instrument.symbol)),
    ).size,
    netCash: sum(rows.map((e) => e.netCash)),
    commissions: covered("commission"),
    taxes: covered("taxes"),
    byAssetClass: counts("assetClass"),
    byEvent: counts("event"),
  };
}

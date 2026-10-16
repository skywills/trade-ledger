import {
  AnalyticsQuerySchema,
  type ExportQuery,
} from "../../shared/analytics.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import { aggregateAnalytics } from "./aggregate.js";
import { checkBuild, selectAnalyticsDetails } from "./details.js";
import { parseDetailQuery } from "./query.js";
import type { AnalyticsSnapshot } from "./snapshot.js";

const numberFields = new Set([
  "quantity",
  "price",
  "netCash",
  "proceeds",
  "commission",
  "taxes",
  "brokerPnl",
  "selectedPnl",
  "openingAmount",
  "cashflow",
  "reconstructedPnl",
  "value",
  "coverageKnown",
  "coverageTotal",
]);
function cell(value: unknown, numeric = false): string {
  let s = value === null || value === undefined ? "" : String(value);
  let prefix = 0;
  while (prefix < s.length && s.charCodeAt(prefix) <= 32) prefix++;
  if (!numeric && /^[=+@-]/.test(s.slice(prefix))) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
export function serializeAnalyticsCsv(
  snapshot: AnalyticsSnapshot,
  query: ExportQuery,
): { filename: string; csv: string } {
  checkBuild(snapshot, query.expectedBuildId);
  const base = AnalyticsQuerySchema.parse(
    Object.fromEntries(
      Object.entries(query).filter(([k]) =>
        [
          "from",
          "to",
          "currency",
          "basis",
          "symbol",
          "underlying",
          "strategyType",
          "assetClass",
        ].includes(k),
      ),
    ),
  );
  const result = aggregateAnalytics(snapshot, base);
  const filters = result.filters;
  const meta = {
    currency: filters.currency ?? "",
    from: filters.from ?? "",
    to: filters.to ?? "",
    basis: filters.basis,
    buildId: snapshot.buildId,
    ledgerId: snapshot.ledgerId,
    generatedAt: snapshot.generatedAt,
  };
  let records: Record<string, unknown>[] = [];
  let columns: string[];
  if (query.dataset === "summary") {
    columns = [
      "section",
      "key",
      "metric",
      "value",
      ...Object.keys(meta),
      "coverageKnown",
      "coverageTotal",
    ];
    const add = (
      section: string,
      key: string,
      metric: string,
      value: unknown,
      known?: number,
      total?: number,
    ) =>
      records.push({
        section,
        key,
        metric,
        value,
        ...meta,
        coverageKnown: known,
        coverageTotal: total,
      });
    for (const [key, value] of Object.entries(result.performance)) {
      if (key === "profitFactor") {
        add(
          "performance",
          "all",
          key,
          result.performance.profitFactor.value ??
            result.performance.profitFactor.state,
        );
        continue;
      }
      add(
        "performance",
        "all",
        key,
        value,
        result.performance.eligible,
        result.performance.closed,
      );
    }
    for (const [dimension, rows] of [
      ["strategyType", result.byStrategyType],
      ["underlying", result.byUnderlying],
      ["month", result.monthly],
    ] as const)
      for (const row of rows)
        for (const metric of [
          "pnl",
          "closed",
          "eligible",
          "wins",
          "losses",
          "breakeven",
          "winRatePct",
        ] as const)
          add(
            dimension,
            row.key,
            metric,
            row[metric],
            row.eligible,
            row.closed,
          );
    for (const metric of ["executions", "tradedSymbols", "netCash"] as const)
      add("transactions", "all", metric, result.transactions[metric]);
    for (const metric of ["commissions", "taxes"] as const) {
      const v = result.transactions[metric];
      add("transactions", "all", metric, v.value, v.known, v.total);
    }
    for (const [metric, value] of Object.entries(result.quality))
      add("quality", "all", metric, value);
  } else {
    const { dataset, ...rest } = query;
    const detail = parseDetailQuery({ ...rest, kind: dataset });
    const size =
      dataset === "strategies"
        ? (snapshot.projection?.strategies.length ?? 0)
        : (snapshot.ledger?.executions.length ?? 0);
    const details = selectAnalyticsDetails(snapshot, {
      ...detail,
      page: 1,
      pageSize: Math.max(size, 1),
    });
    columns =
      dataset === "strategies"
        ? [
            "id",
            "description",
            "type",
            "status",
            "openingDate",
            "closeDate",
            "selectedPnl",
            "brokerPnl",
            "reconstructedPnl",
            ...Object.keys(meta),
          ]
        : [
            "key",
            "date",
            "rawDateTime",
            "symbol",
            "underlying",
            "assetClass",
            "event",
            "action",
            "quantity",
            "price",
            "netCash",
            "commission",
            "taxes",
            "brokerPnl",
            "sources",
            ...Object.keys(meta),
          ];
    records =
      details.kind === "strategies"
        ? details.items.map((s) => ({ ...s, ...meta }))
        : details.items.map((e) => ({
            ...e,
            symbol: e.instrument.symbol,
            underlying: underlyingSymbol(e.instrument),
            assetClass: e.instrument.assetClass,
            sources: JSON.stringify(e.sources),
            ...meta,
          }));
  }
  const csv = `${[
    columns.map((k) => cell(k)).join(","),
    ...records.map((row) =>
      columns
        .map((k) =>
          cell(
            row[k],
            numberFields.has(k) &&
              typeof row[k] !== "object" &&
              /^-?\d+(\.\d+)?$/.test(String(row[k])),
          ),
        )
        .join(","),
    ),
  ].join("\r\n")}\r\n`;
  const safeCurrency = (filters.currency ?? "none").replace(
    /[^a-zA-Z0-9_-]/g,
    "_",
  );
  return {
    filename: `trade-ledger-${query.dataset}-${safeCurrency}-${filters.from ?? "all"}-${filters.to ?? "time"}.csv`,
    csv,
  };
}

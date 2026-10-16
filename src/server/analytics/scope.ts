import { type AnalyticsQuery, validDay } from "../../shared/analytics.js";
import type { Execution, Strategy } from "../../shared/domain.js";
import {
  normalizeSymbol,
  normalizeUnderlyingKey,
  underlyingSymbol,
} from "../../shared/symbols.js";
import { invalid } from "./query.js";
import type { AnalyticsSnapshot } from "./snapshot.js";
export const bucket = (values: readonly string[]): string => {
  const unique = [...new Set(values)];
  return unique.length === 0
    ? "__unknown__"
    : unique.length > 1
      ? "__multi__"
      : `value:${unique[0]}`;
};
export function bucketLabel(key: string, dimension = "underlying"): string {
  return key === "__unknown__"
    ? "Unknown"
    : key === "__multi__"
      ? dimension === "assetClass"
        ? "Multi-asset"
        : "Multi-underlying"
      : key.replace(/^value:/, "");
}
export function inPeriod(date: string | null, q: AnalyticsQuery): boolean {
  return (
    date !== null &&
    validDay(date) &&
    (!q.from || date >= q.from) &&
    (!q.to || date <= q.to)
  );
}
export function selectedPnl(s: Strategy, q: AnalyticsQuery): string | null {
  return q.basis === "broker" ? s.brokerPnl : s.reconstructedPnl;
}
export interface AnalyticsOptions {
  currencies: string[];
  symbols: string[];
  underlyings: { key: string; label: string }[];
  strategyTypes: string[];
  assetClasses: string[];
}
export interface AnalyticsScope {
  snapshot: AnalyticsSnapshot;
  query: AnalyticsQuery;
  options: AnalyticsOptions;
  closed: Strategy[];
  currentOpen: Strategy[];
  unresolved: Strategy[];
  undatedClosed: Strategy[];
  executions: Execution[];
  attribution: Map<string, { underlying: string; assetClass: string }>;
  excludedUnallocated: number;
}
function index(snapshot: AnalyticsSnapshot) {
  const exec = new Map(
    (snapshot.ledger?.executions ?? []).map((x) => [x.key, x]),
  );
  const members = new Map<string, Execution[]>();
  for (const a of snapshot.projection?.allocations ?? []) {
    const e = exec.get(a.executionKey);
    if (e) {
      const rows = members.get(a.strategyId) ?? [];
      rows.push(e);
      members.set(a.strategyId, rows);
    }
  }
  return { exec, members };
}
export function strategyUnderlying(
  strategyId: string,
  snapshot: AnalyticsSnapshot,
): string {
  const { members } = index(snapshot);
  return bucket(
    (members.get(strategyId) ?? []).map((e) => underlyingSymbol(e.instrument)),
  );
}
export function resolveScope(
  snapshot: AnalyticsSnapshot,
  input: AnalyticsQuery,
): AnalyticsScope {
  const all = snapshot.projection?.strategies ?? [];
  const { exec, members } = index(snapshot);
  const executions = [...exec.values()];
  const sorted = (values: string[]) => [...new Set(values)].sort();
  const attribution = new Map(
    all.map((s) => [
      s.id,
      {
        underlying: bucket(
          (members.get(s.id) ?? []).map((e) => underlyingSymbol(e.instrument)),
        ),
        assetClass: bucket(
          (members.get(s.id) ?? []).map((e) => e.instrument.assetClass),
        ),
      },
    ]),
  );
  const keys = sorted(
    [...attribution.values()]
      .map((x) => x.underlying)
      .concat(executions.map((e) => `value:${underlyingSymbol(e.instrument)}`)),
  );
  const options: AnalyticsOptions = {
    currencies: sorted([
      ...all.map((s) => s.currency),
      ...executions.map((e) => e.currency),
    ]),
    symbols: sorted(
      executions.map((e) => normalizeSymbol(e.instrument.symbol)),
    ),
    underlyings: keys.map((key) => ({ key, label: bucketLabel(key) })),
    strategyTypes: sorted(all.map((s) => s.type)),
    assetClasses: sorted(executions.map((e) => e.instrument.assetClass)),
  };
  const query = {
    ...input,
    ...(input.symbol ? { symbol: normalizeSymbol(input.symbol) } : {}),
    ...(input.underlying
      ? { underlying: normalizeUnderlyingKey(input.underlying) }
      : {}),
    currency: input.currency ?? options.currencies[0],
  };
  if (query.currency && !options.currencies.includes(query.currency))
    invalid("Currency is not present in this snapshot.");
  const selected = all.filter(
    (s) =>
      s.currency === query.currency &&
      (!query.strategyType || s.type === query.strategyType) &&
      (!query.underlying ||
        attribution.get(s.id)?.underlying === query.underlying) &&
      (!query.symbol ||
        (members.get(s.id) ?? []).some(
          (e) => normalizeSymbol(e.instrument.symbol) === query.symbol,
        )) &&
      (!query.assetClass ||
        (members.get(s.id) ?? []).some(
          (e) => e.instrument.assetClass === query.assetClass,
        )),
  );
  const selectedIds = new Set(selected.map((s) => s.id));
  const allocated = new Set(
    (snapshot.projection?.allocations ?? []).map((a) => a.executionKey),
  );
  const allowed = new Set(
    (snapshot.projection?.allocations ?? [])
      .filter((a) => selectedIds.has(a.strategyId))
      .map((a) => a.executionKey),
  );
  const baseExec = executions.filter(
    (e) =>
      e.currency === query.currency &&
      inPeriod(e.date, query) &&
      (!query.symbol ||
        normalizeSymbol(e.instrument.symbol) === query.symbol) &&
      (!query.assetClass || e.instrument.assetClass === query.assetClass),
  );
  const strategySpecific = Boolean(query.strategyType || query.underlying);
  const scopedExec = baseExec.filter(
    (e) =>
      (!strategySpecific || allowed.has(e.key)) &&
      (!query.underlying ||
        query.underlying === "__multi__" ||
        query.underlying === "__unknown__" ||
        `value:${underlyingSymbol(e.instrument)}` === query.underlying),
  );
  return {
    snapshot,
    query,
    options,
    attribution,
    closed: selected.filter(
      (s) => s.status === "closed" && inPeriod(s.closeDate, query),
    ),
    currentOpen: selected.filter(
      (s) => s.status === "open" || s.status === "partially_closed",
    ),
    unresolved: selected.filter((s) => s.status === "unresolved"),
    undatedClosed: selected.filter(
      (s) => s.status === "closed" && (!s.closeDate || !validDay(s.closeDate)),
    ),
    executions: scopedExec,
    excludedUnallocated: strategySpecific
      ? baseExec.filter((e) => !allocated.has(e.key)).length
      : 0,
  };
}

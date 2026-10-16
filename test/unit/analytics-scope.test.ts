import { describe, expect, it } from "vitest";
import {
  parseAnalyticsQuery,
  parseDetailQuery,
  parseExportQuery,
} from "../../src/server/analytics/query.js";
import {
  resolveScope,
  strategyUnderlying,
} from "../../src/server/analytics/scope.js";
import { execution, snapshot, strategy } from "../fixtures/analytics.js";

function fixture() {
  const s = snapshot();
  s.projection!.strategies = [
    strategy({ id: "within-period", type: "spread" }),
    strategy({ id: "old-open", status: "open", closeDate: null }),
    strategy({ id: "undated", closeDate: null }),
    strategy({ id: "eur", currency: "EUR" }),
  ];
  s.ledger!.executions = [
    execution({ key: "shared" }),
    execution({ key: "unallocated" }),
  ];
  s.projection!.allocations = ["within-period", "old-open"].map(
    (strategyId) => ({
      strategyId,
      executionKey: "shared",
      quantity: "1",
      netCash: "-100",
      brokerPnl: "0",
      pnlEstimated: false,
      role: "close" as const,
    }),
  );
  return s;
}
describe("analytics scopes", () => {
  it.each([
    { from: "2026-02-30" },
    { from: "2026-10-16", to: "2026-10-01" },
    { mystery: "USD" },
    { currency: ["USD", "EUR"] },
  ])("rejects malformed filters %o", (raw) =>
    expect(() => parseAnalyticsQuery(raw)).toThrow(),
  );
  it.each([
    { kind: "transactions", scope: "current-open" },
    { kind: "transactions", outcome: "win" },
    { kind: "strategies", sort: "netCash" },
    { kind: "strategies", page: "0" },
    { kind: "strategies", pageSize: "101" },
    { kind: "strategies", group: "A" },
    { kind: "strategies", groupBy: "event", group: "trade" },
  ])("rejects invalid drill-down %o", (raw) =>
    expect(() => parseDetailQuery(raw)).toThrow(),
  );
  it("defaults currency in sorted full-snapshot options and retains choices", () => {
    const s = fixture();
    const a = resolveScope(s, parseAnalyticsQuery({}));
    expect(a.query.currency).toBe("EUR");
    expect(a.options.currencies).toEqual(["EUR", "USD"]);
    expect(
      resolveScope(s, parseAnalyticsQuery({ currency: "USD", symbol: "none" }))
        .options,
    ).toEqual(a.options);
    expect(() =>
      resolveScope(s, parseAnalyticsQuery({ currency: "JPY" })),
    ).toThrow();
    expect(
      resolveScope(snapshot(), parseAnalyticsQuery({})).query.currency,
    ).toBeUndefined();
  });
  it("keeps current opens outside period and excludes undated closed", () => {
    const a = resolveScope(
      fixture(),
      parseAnalyticsQuery({
        currency: "USD",
        from: "2026-09-01",
        to: "2026-09-30",
      }),
    );
    expect(a.closed.map((x) => x.id)).toEqual(["within-period"]);
    expect(a.currentOpen.map((x) => x.id)).toEqual(["old-open"]);
    expect(a.undatedClosed.map((x) => x.id)).toEqual(["undated"]);
  });
  it("deduplicates allocated transactions while retaining unallocated without type filters", () => {
    const s = fixture();
    const a = resolveScope(
      s,
      parseAnalyticsQuery({ currency: "USD", strategyType: "spread" }),
    );
    expect(a.executions.map((x) => x.key)).toEqual(["shared"]);
    expect(a.excludedUnallocated).toBe(1);
    expect(
      resolveScope(s, parseAnalyticsQuery({ currency: "USD" })).executions,
    ).toHaveLength(2);
  });
  it("attributes multi-underlying exclusively and separates exact symbol filters", () => {
    const s = fixture();
    s.ledger!.executions.push(
      execution({
        key: "b",
        instrument: { ...execution().instrument, symbol: "B", underlying: "B" },
      }),
    );
    s.projection!.allocations.push({
      ...s.projection!.allocations[0]!,
      executionKey: "b",
    });
    expect(strategyUnderlying("within-period", s)).toBe("__multi__");
    expect(strategyUnderlying("undated", s)).toBe("__unknown__");
    expect(
      resolveScope(
        s,
        parseAnalyticsQuery({ currency: "USD", symbol: "B" }),
      ).closed.map((x) => x.id),
    ).toEqual(["within-period"]);
    expect(
      resolveScope(
        s,
        parseAnalyticsQuery({ currency: "USD", underlying: "value:A" }),
      ).closed,
    ).toHaveLength(0);
  });
  it("validates export scope but never accepts pagination", () => {
    expect(
      parseExportQuery({ dataset: "strategies", scope: "current-open" }).scope,
    ).toBe("current-open");
    expect(() =>
      parseExportQuery({ dataset: "transactions", page: "2" }),
    ).toThrow();
  });
});

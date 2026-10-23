import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { serializeAnalyticsCsv } from "../../src/server/analytics/csv.js";
import { selectAnalyticsDetails } from "../../src/server/analytics/details.js";
import {
  parseAnalyticsQuery,
  parseDetailQuery,
  parseExportQuery,
} from "../../src/server/analytics/query.js";
import type { Lifecycle } from "../../src/shared/lifecycles.js";
import { execution, snapshot, strategy } from "../fixtures/analytics.js";

function fixture() {
  const s = snapshot();
  const closed: Lifecycle = {
    ...strategy({ id: "closed", closeDate: "2026-02-01", brokerPnl: "100" }),
    account: "SIM",
    underlyingKey: "value:A",
    originStrategyType: "stock",
    stage: "closed",
    campaignId: "closed-wheel",
    coveredShares: "0",
    uncoveredShares: "0",
    componentIds: ["closed-part"],
  };
  const open: Lifecycle = {
    ...closed,
    id: "open",
    status: "partially_closed",
    closeDate: null,
    brokerPnl: null,
    stage: "assigned_stock",
    campaignId: "open-wheel",
    positions: [{ instrumentKey: "STK:A", quantity: "1" }],
  };
  s.ledger.executions = [
    execution({
      key: "shared",
      date: "2026-01-10",
      quantity: "-2",
      netCash: "200",
      brokerPnl: "40",
    }),
    execution({
      key: "later",
      date: "2026-02-01",
      quantity: "-1",
      netCash: "100",
      brokerPnl: "70",
    }),
  ];
  s.projection.lifecycles = {
    version: 1,
    lifecycles: [closed, open],
    campaigns: [],
    suggestions: [],
    issues: [],
    valuations: [],
    members: [
      {
        lifecycleId: "closed",
        allocation: {
          strategyId: "closed-part",
          executionKey: "shared",
          role: "close",
        },
        quantity: "-1",
        netCash: "100",
        brokerPnl: "30",
        estimated: false,
        sources: [],
      },
      {
        lifecycleId: "open",
        allocation: {
          strategyId: "open-part",
          executionKey: "shared",
          role: "close",
        },
        quantity: "-1",
        netCash: "100",
        brokerPnl: "10",
        estimated: false,
        sources: [],
      },
      {
        lifecycleId: "closed",
        allocation: {
          strategyId: "closed-part",
          executionKey: "later",
          role: "close",
        },
        quantity: "-1",
        netCash: "100",
        brokerPnl: "70",
        estimated: false,
        sources: [],
      },
    ],
  };
  return s;
}
const january = {
  currency: "USD",
  basis: "broker",
  from: "2026-01-01",
  to: "2026-01-31",
};

describe("recorded realized P&L by current lifecycle status", () => {
  it("uses execution dates and apportioned member P&L without counting a shared execution twice", () => {
    const s = fixture();
    const result = aggregateAnalytics(s, parseAnalyticsQuery(january));
    expect(result.performance.closed).toBe(0);
    expect(result.realizedPnl).toMatchObject({
      completed: { value: "30" },
      open: { value: "10" },
      total: { value: "40" },
      unresolved: { value: "0" },
    });
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({ currency: "USD" }))
        .realizedPnl,
    ).toMatchObject({
      completed: { value: "100" },
      open: { value: "10" },
      total: { value: "110" },
    });
  });
  it("drills and exports the exact contributing open lifecycles and their period realized amount", () => {
    const s = fixture();
    const q = { ...january, kind: "strategies", scope: "realized-open" };
    const detail = selectAnalyticsDetails(s, parseDetailQuery(q));
    expect(detail.total).toBe(1);
    expect(detail.items[0]).toMatchObject({
      id: "open",
      status: "partially_closed",
      selectedPnl: "10",
      brokerPnl: "10",
    });
    const rows = parse(
      serializeAnalyticsCsv(
        s,
        parseExportQuery({
          ...january,
          dataset: "strategies",
          scope: "realized-open",
        }),
      ).csv,
      { columns: true },
    ) as Record<string, string>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "open", selectedPnl: "10" });
    expect(
      selectAnalyticsDetails(
        s,
        parseDetailQuery({ ...q, scope: "realized-completed" }),
      ).items[0],
    ).toMatchObject({ id: "closed", selectedPnl: "30" });
  });
  it("honors membership, campaign and account filters when the source execution is shared", () => {
    const s = fixture();
    expect(
      aggregateAnalytics(
        s,
        parseAnalyticsQuery({ ...january, campaignId: "open-wheel" }),
      ).realizedPnl,
    ).toMatchObject({
      completed: { value: "0" },
      open: { value: "10" },
      total: { value: "10" },
    });
    expect(
      aggregateAnalytics(
        s,
        parseAnalyticsQuery({ ...january, account: "OTHER" }),
      ).realizedPnl?.total.value,
    ).toBe("0");
    expect(
      aggregateAnalytics(
        s,
        parseAnalyticsQuery({ ...january, underlying: "value:OTHER" }),
      ).realizedPnl?.total.value,
    ).toBe("0");
  });
  it("retains negative and missing realized amounts without calling missing P&L zero", () => {
    const s = fixture();
    const member = s.projection.lifecycles?.members[1];
    const shared = s.ledger.executions[0];
    if (!member || !shared) throw Error("Missing fixture member");
    member.brokerPnl = "-10";
    shared.brokerPnl = "20";
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery(january)).realizedPnl?.open
        .value,
    ).toBe("-10");
    member.brokerPnl = null;
    shared.brokerPnl = null;
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery(january)).realizedPnl,
    ).toMatchObject({
      open: { value: null, known: 0, total: 1 },
      total: { value: null, knownValue: "0" },
    });
  });
  it("keeps unresolved and unallocated recorded P&L separate from completed and open lifecycles", () => {
    const s = fixture();
    const open = s.projection.lifecycles?.lifecycles[1];
    if (!open) throw Error("Missing fixture lifecycle");
    open.status = "unresolved";
    s.ledger.executions.push(
      execution({ key: "unallocated", date: "2026-01-20", brokerPnl: "5" }),
    );
    const result = aggregateAnalytics(s, parseAnalyticsQuery(january));
    expect(result.realizedPnl).toMatchObject({
      completed: { value: "30" },
      open: { value: "0" },
      unresolved: { value: "15" },
      total: { value: "45" },
    });
    const detail = selectAnalyticsDetails(
      s,
      parseDetailQuery({
        ...january,
        kind: "transactions",
        scope: "realized-unresolved",
      }),
    );
    expect(detail.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "shared",
          brokerPnl: "10",
          quantity: "-1",
        }),
        expect.objectContaining({ key: "unallocated", brokerPnl: "5" }),
      ]),
    );
  });
  it("does not mix broker realized figures into reconstructed or strategy performance", () => {
    const s = fixture();
    expect(
      aggregateAnalytics(
        s,
        parseAnalyticsQuery({ ...january, basis: "reconstructed" }),
      ).realizedPnl,
    ).toBeUndefined();
    expect(
      aggregateAnalytics(
        s,
        parseAnalyticsQuery({ ...january, unit: "strategy" }),
      ).realizedPnl,
    ).toBeUndefined();
    expect(() =>
      parseDetailQuery({
        ...january,
        kind: "strategies",
        scope: "realized-open",
        basis: "reconstructed",
      }),
    ).toThrow();
  });
});

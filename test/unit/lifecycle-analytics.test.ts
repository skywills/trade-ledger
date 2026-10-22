import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { serializeAnalyticsCsv } from "../../src/server/analytics/csv.js";
import { selectAnalyticsDetails } from "../../src/server/analytics/details.js";
import { campaignSummary } from "../../src/server/analytics/lifecycles.js";
import {
  parseAnalyticsQuery,
  parseDetailQuery,
  parseExportQuery,
} from "../../src/server/analytics/query.js";
import type { Lifecycle } from "../../src/shared/lifecycles.js";
import {
  changeDashboard,
  dashboardHref,
  readDashboardQuery,
} from "../../src/web/dashboard/query.js";
import { execution, snapshot, strategy } from "../fixtures/analytics.js";

function fixture() {
  const s = snapshot();
  const parts = ["spread", "stock", "call-1", "call-2", "call-3"];
  s.projection.strategies = parts.map((id) =>
    strategy({ id, brokerPnl: "10" }),
  );
  s.ledger.executions = parts.map((key, i) =>
    execution({
      key,
      date: "2026-08-01",
      netCash: String(i + 1),
      instrument: {
        ...execution().instrument,
        assetClass: i === 1 ? "STK" : "OPT",
      },
    }),
  );
  s.projection.allocations = parts.map((strategyId) => ({
    strategyId,
    executionKey: strategyId,
    quantity: "1",
    netCash: "3",
    brokerPnl: "10",
    pnlEstimated: false,
    role: "close",
  }));
  const cycle: Lifecycle = {
    ...strategy({
      id: "cycle",
      type: "stock",
      brokerPnl: "800",
      reconstructedPnl: "790",
    }),
    account: "SIM",
    underlyingKey: "STK:A",
    originStrategyType: "bull_put_spread",
    stage: "closed",
    campaignId: "wheel",
    coveredShares: "0",
    uncoveredShares: "0",
    componentIds: parts,
  };
  s.projection.lifecycles = {
    version: 1,
    lifecycles: [cycle],
    members: parts.map((strategyId, i) => ({
      lifecycleId: "cycle",
      allocation: { strategyId, executionKey: strategyId, role: "close" },
      quantity: "1",
      netCash: String(i + 1),
      brokerPnl: "10",
      estimated: false,
      sources: [],
    })),
    campaigns: [
      {
        id: "wheel",
        name: "A wheel",
        account: "SIM",
        currency: "USD",
        underlyingKey: "STK:A",
        lifecycleIds: ["cycle"],
      },
    ],
    suggestions: [],
    issues: [],
    valuations: [],
  };
  return s;
}

function data(s: ReturnType<typeof fixture>) {
  const projection = s.projection.lifecycles;
  if (!projection) throw new Error("Missing fixture lifecycle projection");
  return projection;
}
function cycle(s: ReturnType<typeof fixture>) {
  const row = data(s).lifecycles[0];
  if (!row) throw new Error("Missing fixture lifecycle");
  return row;
}

describe("lifecycle analytics", () => {
  it.each(["lifecycle", "strategy"] as const)(
    "drills into only eligible estimated broker results in %s mode and exports the same rows",
    (unit) => {
      const s = fixture();
      const member = data(s).members[0];
      const allocation = s.projection.allocations[0];
      if (!member || !allocation) throw Error("Missing fixture allocation");
      member.estimated = true;
      allocation.pnlEstimated = true;
      // A reason alone is not proof of an estimated broker allocation.
      data(s).lifecycles.push({
        ...cycle(s),
        id: "ordinary",
        reasons: ["ESTIMATED_PNL"],
      });
      const query = { unit, basis: "broker", currency: "USD" };
      const summary = aggregateAnalytics(s, parseAnalyticsQuery(query));
      const detail = selectAnalyticsDetails(
        s,
        parseDetailQuery({
          ...query,
          kind: "strategies",
          scope: "estimated-closed",
          pageSize: 1,
        }),
      );
      expect(detail.total).toBe(1);
      expect(detail.total).toBe(summary.quality.estimatedClosed);
      if (detail.kind !== "strategies")
        throw Error("Expected strategy details");
      expect(detail.items[0]?.id).toBe(
        unit === "lifecycle" ? "cycle" : "spread",
      );
      const exported = parse(
        serializeAnalyticsCsv(
          s,
          parseExportQuery({
            ...query,
            dataset: "strategies",
            scope: "estimated-closed",
          }),
        ).csv,
        { columns: true },
      ) as Record<string, string>[];
      expect(exported).toHaveLength(1);
      expect(exported[0]?.id).toBe(unit === "lifecycle" ? "cycle" : "spread");
      expect(
        selectAnalyticsDetails(
          s,
          parseDetailQuery({
            ...query,
            kind: "strategies",
            scope: "estimated-closed",
            from: "2026-10-01",
          }),
        ).total,
      ).toBe(0);
      cycle(s).complete = false;
      if (unit === "lifecycle")
        expect(
          selectAnalyticsDetails(
            s,
            parseDetailQuery({
              ...query,
              kind: "strategies",
              scope: "estimated-closed",
            }),
          ).total,
        ).toBe(0);
    },
  );

  it("defaults to one complete lifecycle and preserves explicit component results", () => {
    const s = fixture();
    const r = aggregateAnalytics(s, parseAnalyticsQuery({}));
    expect(r.filters.unit).toBe("lifecycle");
    expect(r.performance).toMatchObject({
      closed: 1,
      eligible: 1,
      wins: 1,
      pnl: "800",
    });
    expect(r.byStrategyType[0]?.key).toBe("value:bull_put_spread");
    expect(r.daily[0]?.date).toBe("2026-09-20");
    expect(r.monthly.find((x) => x.month === "2026-08")?.netCash).toBe("15");
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({ unit: "strategy" }))
        .performance,
    ).toMatchObject({ closed: 5, pnl: "50" });
  });
  it("member and campaign filters retain all lifecycle cash in summary, drills and CSV", () => {
    const s = fixture();
    const filters = {
      assetClass: "OPT",
      campaignId: "wheel",
      basis: "reconstructed",
    };
    const r = aggregateAnalytics(s, parseAnalyticsQuery(filters));
    expect(r.performance.pnl).toBe("790");
    expect(r.transactions.netCash).toBe("15");
    const d = selectAnalyticsDetails(
      s,
      parseDetailQuery({ ...filters, kind: "strategies", pageSize: 1 }),
    );
    expect(d.total).toBe(1);
    expect(d.items[0]).toMatchObject({ id: "cycle", selectedPnl: "790" });
    const rows = parse(
      serializeAnalyticsCsv(
        s,
        parseExportQuery({ ...filters, dataset: "strategies" }),
      ).csv,
      { columns: true },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "cycle",
      unit: "lifecycle",
      campaignId: "wheel",
      stage: "closed",
      account: "SIM",
      selectedPnl: "790",
    });
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({ campaignId: "other" }))
        .performance.closed,
    ).toBe(0);
  });
  it("excludes open and missing results without a fallback between bases", () => {
    const s = fixture();
    const row = cycle(s);
    row.brokerPnl = null;
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({})).performance,
    ).toMatchObject({ eligible: 0, missing: 1, wins: 0, pnl: null });
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({ basis: "reconstructed" }))
        .performance.pnl,
    ).toBe("790");
    row.status = "open";
    row.closeDate = null;
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({})).performance,
    ).toMatchObject({ closed: 0, open: 1, wins: 0, losses: 0 });
  });
  it("requires rebuild for historical projections and rejects campaign filters in strategy mode", () => {
    expect(() =>
      aggregateAnalytics(snapshot(), parseAnalyticsQuery({})),
    ).toThrow(/rebuild/i);
    expect(() =>
      parseAnalyticsQuery({ unit: "strategy", campaignId: "wheel" }),
    ).toThrow();
    expect(() =>
      parseDetailQuery({
        kind: "strategies",
        unit: "strategy",
        campaignId: "wheel",
      }),
    ).toThrow();
    expect(() =>
      parseExportQuery({
        dataset: "summary",
        unit: "strategy",
        campaignId: "wheel",
      }),
    ).toThrow();
  });
  it("withholds financially incomplete closed observations even when a stored amount exists", () => {
    const s = fixture();
    cycle(s).complete = false;
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({})).performance,
    ).toMatchObject({ closed: 1, eligible: 0, missing: 1, pnl: null });
  });
  it("reports campaign coverage and open estimates separately without adding observations", () => {
    const s = fixture(),
      p = data(s),
      first = cycle(s);
    p.lifecycles.push(
      {
        ...first,
        id: "missing",
        brokerPnl: null,
        reconstructedPnl: null,
        complete: false,
      },
      {
        ...first,
        id: "open",
        status: "open",
        closeDate: null,
        stage: "assigned_stock",
        brokerPnl: "50",
        reconstructedPnl: null,
      },
    );
    p.valuations.push({
      lifecycleId: "open",
      asOf: "2026-10-01T12:00:00Z",
      source: "manual",
      cashflow: "-9800",
      realizedBrokerPnl: "50",
      unrealizedPnl: "-350",
      totalPnl: "-300",
      estimated: true,
      reasons: [],
    });
    expect(campaignSummary(p, "wheel")).toMatchObject({
      completed: 2,
      open: 1,
      complete: 1,
      missing: 1,
      broker: {
        eligible: 1,
        missing: 1,
        wins: 1,
        pnl: { value: null, knownValue: "800", known: 1, total: 2 },
      },
      reconstructed: { pnl: { value: null, knownValue: "790" } },
      openValuation: { value: "-300", knownValue: "-300", known: 1, total: 1 },
    });
    p.valuations = [];
    expect(campaignSummary(p, "wheel").openValuation).toMatchObject({
      value: null,
      knownValue: null,
      known: 0,
      total: 1,
    });
    expect(
      aggregateAnalytics(s, parseAnalyticsQuery({ campaignId: "wheel" }))
        .performance,
    ).toMatchObject({ closed: 2, eligible: 1, open: 1 });
  });
  it("preserves unit/campaign/account in URLs and clears campaign when selecting components", () => {
    const state = readDashboardQuery(
      "?unit=lifecycle&campaignId=wheel&account=SIM",
      "overview",
      "2026-10-18",
    );
    expect(state.error).toBeNull();
    expect(dashboardHref("reports", state)).toContain("campaignId=wheel");
    expect(dashboardHref("reports", state)).toContain("account=SIM");
    expect(
      changeDashboard(state, { unit: "strategy" }).query.campaignId,
    ).toBeUndefined();
  });
  it("retains only selected membership slices of executions shared across campaigns", () => {
    const s = fixture(),
      p = data(s),
      first = cycle(s);
    s.ledger.executions = [
      execution({
        key: "shared",
        quantity: "-150",
        netCash: "1500",
        brokerPnl: "150",
        commission: "-3",
        taxes: "-1.5",
      }),
    ];
    p.lifecycles = [
      { ...first, cashflow: "1000", brokerPnl: "100" },
      {
        ...first,
        id: "other",
        campaignId: "other-wheel",
        cashflow: "500",
        brokerPnl: "50",
      },
    ];
    p.members = [
      {
        lifecycleId: "cycle",
        allocation: {
          strategyId: "stock",
          executionKey: "shared",
          role: "close",
        },
        quantity: "-100",
        netCash: "1000",
        brokerPnl: "100",
        estimated: false,
        sources: [],
      },
      {
        lifecycleId: "other",
        allocation: {
          strategyId: "stock",
          executionKey: "shared",
          role: "close",
        },
        quantity: "-50",
        netCash: "500",
        brokerPnl: "50",
        estimated: false,
        sources: [],
      },
    ];
    const r = aggregateAnalytics(
      s,
      parseAnalyticsQuery({ campaignId: "wheel" }),
    );
    expect(r.performance.pnl).toBe("100");
    expect(r.transactions).toMatchObject({
      executions: 1,
      netCash: "1000",
      commissions: { value: "-2" },
      taxes: { value: "-1" },
    });
    const d = selectAnalyticsDetails(
      s,
      parseDetailQuery({ kind: "transactions", campaignId: "wheel" }),
    );
    expect(d.items[0]).toMatchObject({
      key: "shared",
      quantity: "-100",
      netCash: "1000",
      brokerPnl: "100",
    });
  });
});

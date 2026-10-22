import { Decimal } from "decimal.js";
import { expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { parseAnalyticsQuery } from "../../src/server/analytics/query.js";
import { readAnalyticsSnapshot } from "../../src/server/analytics/snapshot.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  computeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import type { LedgerSnapshot } from "../../src/shared/domain.js";
import { execution, put } from "../fixtures/lifecycles.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

it("conserves repeating basis-derived P&L through lifecycle projection", async () => {
  const { store, dispose } = await createTestStore();
  try {
    const ledger: LedgerSnapshot = {
      id: "ledger",
      inputHash: "input",
      lots: [],
      issues: [],
      conflicts: 0,
      executions: [
        {
          ...execution("a", put, "3", "-10", 1, "open"),
          basis: "10",
          brokerPnl: "0",
        },
        {
          ...execution("b", put, "3", "-20", 1, "open"),
          basis: "20",
          brokerPnl: "0",
        },
        {
          ...execution("close", put, "-2", "12", 2, "close"),
          basis: "-10",
          brokerPnl: "2",
        },
      ],
    };
    const result = await computeProjection(store, ledger, 0);
    const closes = result.allocations.filter((a) => a.role === "close");
    expect(closes.map((a) => a.brokerPnl).sort()).toEqual([
      "-0.6666666666666666667",
      "2.6666666666666666667",
    ]);
    expect(
      closes
        .reduce((sum, a) => sum.plus(a.brokerPnl ?? "0"), new Decimal(0))
        .toFixed(),
    ).toBe("2");
    const members =
      result.lifecycles?.members.filter((m) => m.allocation.role === "close") ??
      [];
    expect(members).toHaveLength(2);
    for (const allocation of closes) {
      expect(
        members.find((m) => m.allocation.strategyId === allocation.strategyId),
      ).toMatchObject({
        brokerPnl: allocation.brokerPnl,
        estimated: false,
        pnlAttribution: "basis-reconciled",
      });
    }
    expect(
      result.issues.filter((issue) => issue.code === "LIFECYCLE_CONSERVATION"),
    ).toEqual([]);
  } finally {
    await dispose();
  }
});

it("preserves basis-reconciled attribution through persisted full rebuilds and duplicate re-imports", async () => {
  const t = await createTestStore();
  try {
    const common = {
      ClientAccountID: "SIM",
      AssetClass: "OPT",
      Symbol: "SYN  261016C00100000",
      UnderlyingSymbol: "SYN",
      CurrencyPrimary: "USD",
      Multiplier: "100",
    };
    const bytes = buildExecutionTable([
      executionRow({
        ...common,
        IBExecID: "first",
        TradeDate: "20261001",
        DateTime: "20261001;100000",
        Quantity: "1",
        NetCash: "-10",
        CostBasis: "10",
        FifoPnlRealized: "0",
        "Notes/Codes": "O",
      }),
      executionRow({
        ...common,
        IBExecID: "second",
        TradeDate: "20261002",
        DateTime: "20261002;100000",
        Quantity: "1",
        NetCash: "-20",
        CostBasis: "20",
        FifoPnlRealized: "0",
        "Notes/Codes": "O",
      }),
      executionRow({
        ...common,
        IBExecID: "sale",
        TradeDate: "20261003",
        DateTime: "20261003;100000",
        Quantity: "-2",
        NetCash: "50",
        CostBasis: "-30",
        FifoPnlRealized: "20",
        "Notes/Codes": "C",
      }),
    ]);
    const preview = await previewImport(t.store, {
      filename: "mixed.csv",
      bytes,
      timezone: "UTC",
    });
    await commitImport(t.store, preview.id);
    for (let round = 0; round < 2; round++) {
      if (round) {
        const again = await previewImport(t.store, {
          filename: "mixed.csv",
          bytes,
          timezone: "UTC",
        });
        expect((await commitImport(t.store, again.id)).duplicate).toBe(true);
      }
      await rebuild(t.store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      const projection = activeProjection(t.store).projection;
      const allocations =
        projection?.allocations.filter((a) => a.role === "close") ?? [];
      expect(allocations).toHaveLength(2);
      for (const a of allocations)
        expect(a).toMatchObject({
          pnlEstimated: false,
          pnlAttribution: "basis-reconciled",
        });
      for (const m of projection?.lifecycles?.members.filter(
        (m) => m.allocation.role === "close",
      ) ?? [])
        expect(m).toMatchObject({
          estimated: false,
          pnlAttribution: "basis-reconciled",
        });
      for (const unit of ["lifecycle", "strategy"]) {
        const dashboard = aggregateAnalytics(
          readAnalyticsSnapshot(t.store),
          parseAnalyticsQuery({ unit, currency: "USD", basis: "broker" }),
        );
        expect(dashboard.performance).toMatchObject({ closed: 2, pnl: "20" });
        expect(dashboard.quality).toMatchObject({
          estimatedClosed: 0,
          basisReconciledClosed: 2,
        });
      }
    }
  } finally {
    await t.dispose();
  }
});

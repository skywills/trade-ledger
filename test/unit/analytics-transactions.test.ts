import { describe, expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { execution, snapshot, strategy } from "../fixtures/analytics.js";

describe("transaction analytics", () => {
  it("deduplicates keys, sums charges and credits, and keeps known zero", () => {
    const s = snapshot();
    const a = execution({ key: "a", commission: "-1", taxes: "0" });
    s.ledger.executions = [
      a,
      a,
      execution({ key: "b", commission: "0.25", event: "unsupported" }),
    ];
    const r = aggregateAnalytics(s, { currency: "USD", basis: "broker" });
    expect(r.transactions).toMatchObject({
      executions: 2,
      tradedSymbols: 1,
      netCash: "-200",
      commissions: { value: "-0.75", known: 2, total: 2 },
      taxes: { value: "0", known: 1, total: 2 },
    });
    expect(r.transactions.byEvent).toContainEqual({
      key: "unsupported",
      label: "unsupported",
      count: 1,
    });
  });
  it("uses independent execution dates and all rows beyond pagination", () => {
    const s = snapshot();
    s.projection.strategies = [
      strategy({ brokerPnl: "5", closeDate: "2026-10-01" }),
    ];
    s.ledger.executions = Array.from({ length: 150 }, (_, i) =>
      execution({ key: `e${i}`, netCash: "0.1" }),
    );
    const r = aggregateAnalytics(s, {
      currency: "USD",
      basis: "broker",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(r.performance.pnl).toBeNull();
    expect(r.transactions).toMatchObject({
      executions: 150,
      netCash: "15",
      commissions: { value: null, known: 0, total: 150 },
    });
    expect(r.monthly[0]?.executions).toBe(150);
  });
  it("preserves precision without changing global Decimal configuration", () => {
    const s = snapshot();
    s.ledger.executions = [
      execution({ key: "a", netCash: "100000000000000000000.123456789" }),
      execution({ key: "b", netCash: "0.000000001" }),
    ];
    expect(
      aggregateAnalytics(s, { currency: "USD", basis: "broker" }).transactions
        .netCash,
    ).toBe("100000000000000000000.12345679");
  });
});

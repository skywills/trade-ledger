import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { AnalyticsResponseSchema } from "../../src/shared/analytics.js";
import {
  performanceFixture,
  snapshot,
  strategy,
} from "../fixtures/analytics.js";

function run(
  values: (string | null)[],
  basis: "broker" | "reconstructed" = "broker",
) {
  const s = snapshot();
  s.projection.strategies = values.map((brokerPnl, i) =>
    strategy({
      id: `s${i}`,
      brokerPnl,
      reconstructedPnl: null,
      closeDate: `2026-09-${String(20 + i).padStart(2, "0")}`,
    }),
  );
  return aggregateAnalytics(s, { currency: "USD", basis });
}
describe("performance analytics", () => {
  it("reconciles all 679 trades and 19 current opens", () => {
    const r = aggregateAnalytics(performanceFixture(), {
      currency: "USD",
      basis: "broker",
    });
    expect(r.performance).toMatchObject({
      closed: 679,
      eligible: 679,
      wins: 481,
      losses: 198,
      pnl: "10456.24",
      open: 19,
      partiallyClosed: 0,
    });
    expect(new Decimal(r.performance.winRatePct ?? "0").toFixed(2)).toBe(
      "70.84",
    );
    expect(r.recent).toHaveLength(10);
    expect(AnalyticsResponseSchema.safeParse(r).success).toBe(true);
  });
  it("adds exact decimals and classifies before rounding", () => {
    expect(run(["0.1", "0.2"]).performance.pnl).toBe("0.3");
    expect(run(["0.001", "0", null]).performance).toMatchObject({
      wins: 1,
      breakeven: 1,
      missing: 1,
      winRatePct: "50",
    });
  });
  it("does not substitute basis or turn missing into zero", () => {
    expect(run(["5"], "reconstructed").performance.pnl).toBeNull();
    const r = run([null, null]);
    expect(r.performance.pnl).toBeNull();
    expect(r.daily.every((x) => x.cumulative === null)).toBe(true);
    expect(r.byUnderlying[0]?.pnl).toBeNull();
  });
  it("calculates factor and realized drawdown from an initial zero peak", () => {
    expect(run(["10", "-4"]).performance.profitFactor).toEqual({
      state: "finite",
      value: "2.5",
    });
    expect(run(["-5", "8", "-7"]).performance.maxDrawdown).toBe("7");
    expect(run(["10"]).performance.profitFactor.state).toBe("no-losses");
    expect(run(["0"]).performance.profitFactor.state).toBe("unavailable");
  });
  it("excludes currencies and undated records and reconciles exclusive groups", () => {
    const s = snapshot();
    s.projection.strategies = [
      strategy({ id: "a", type: "spread", brokerPnl: "3" }),
      strategy({ id: "b", type: "stock", brokerPnl: "-1" }),
      strategy({ id: "eur", currency: "EUR", brokerPnl: "99" }),
      strategy({ id: "undated", closeDate: null, brokerPnl: "100" }),
    ];
    const r = aggregateAnalytics(s, { currency: "USD", basis: "broker" });
    expect(r.performance.pnl).toBe("2");
    expect(r.quality.undatedClosed).toBe(1);
    expect(r.byStrategyType.map((x) => x.pnl)).toEqual(["3", "-1"]);
    expect(r.byUnderlying).toHaveLength(1);
    expect(r.daily).toHaveLength(1);
  });
  it("returns explicit no-build and missing-only month states", () => {
    const s = snapshot({
      buildId: null,
      ledgerId: null,
      projection: null,
      ledger: null,
    });
    expect(
      aggregateAnalytics(s, { basis: "broker" }).performance.pnl,
    ).toBeNull();
    const r = run([null]);
    expect(r.monthly[0]).toMatchObject({ pnl: null, eligible: 0, missing: 1 });
  });
});

describe("allocation attribution and estimates", () => {
  it("counts a multi-underlying strategy once and discloses only contributing estimates", async () => {
    const { execution } = await import("../fixtures/analytics.js");
    const s = snapshot();
    s.projection.strategies = [
      strategy({ id: "spread", brokerPnl: "5", reconstructedPnl: "4" }),
    ];
    s.ledger.executions = [
      execution({ key: "a" }),
      execution({
        key: "b",
        instrument: { ...execution().instrument, symbol: "B", underlying: "B" },
      }),
    ];
    s.projection.allocations = ["a", "b"].map((executionKey) => ({
      strategyId: "spread",
      executionKey,
      quantity: "1",
      netCash: "0",
      brokerPnl: "2.5",
      pnlEstimated: true,
      role: "close" as const,
    }));
    const broker = aggregateAnalytics(s, { basis: "broker", currency: "USD" });
    expect(broker.byUnderlying).toEqual([
      expect.objectContaining({ key: "__multi__", pnl: "5", closed: 1 }),
    ]);
    expect(broker.quality.estimatedClosed).toBe(1);
    const reconstructed = aggregateAnalytics(s, {
      basis: "reconstructed",
      currency: "USD",
    });
    expect(reconstructed.performance.pnl).toBe("4");
    expect(reconstructed.quality.estimatedClosed).toBe(0);
  });
});

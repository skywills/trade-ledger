import type { AnalyticsSnapshot } from "../../src/server/analytics/snapshot.js";
import type { Execution, Strategy } from "../../src/shared/domain.js";
export function strategy(patch: Partial<Strategy> = {}): Strategy {
  return {
    id: "s",
    type: "stock",
    currency: "USD",
    description: "Synthetic trade",
    openingDate: "2026-09-01",
    closeDate: "2026-09-20",
    expiry: null,
    expiryYear: null,
    status: "closed",
    complete: true,
    openingAmount: null,
    cashflow: "0",
    brokerPnl: "0",
    reconstructedPnl: "0",
    positions: [],
    reasons: [],
    ...patch,
  };
}
export function execution(patch: Partial<Execution> = {}): Execution {
  return {
    key: "e",
    account: "SIM",
    instrument: {
      key: "STK:A",
      assetClass: "STK",
      symbol: "A",
      underlying: "A",
      conid: null,
      expiry: null,
      strike: null,
      putCall: null,
      multiplier: "1",
    },
    date: "2026-09-20",
    rawDateTime: "2026-09-20 12:00:00",
    timezone: "UTC",
    quantity: "1",
    price: "100",
    currency: "USD",
    netCash: "-100",
    proceeds: "-100",
    commission: null,
    taxes: null,
    basis: null,
    brokerPnl: null,
    action: "close",
    event: "trade",
    brokerIds: {},
    codes: [],
    sources: [],
    ...patch,
  };
}
export function snapshot(
  patch: Partial<AnalyticsSnapshot> = {},
): AnalyticsSnapshot {
  return {
    buildId: "build",
    ledgerId: "ledger",
    generatedAt: "2026-10-16T00:00:00.000Z",
    stale: false,
    projection: {
      ledgerId: "ledger",
      watermark: 0,
      strategies: [],
      allocations: [],
      links: [],
      issues: [],
    },
    ledger: {
      id: "ledger",
      inputHash: "test",
      executions: [],
      lots: [],
      issues: [],
      conflicts: 0,
    },
    ...patch,
  };
}
export function performanceFixture(): AnalyticsSnapshot {
  const s = snapshot();
  s.projection!.strategies = Array.from({ length: 698 }, (_, i) =>
    strategy({
      id: `s-${i}`,
      brokerPnl:
        i < 481 ? "100" : i < 678 ? "-190" : i === 678 ? "-213.76" : null,
      reconstructedPnl: null,
      status: i < 679 ? "closed" : "open",
      closeDate: i < 679 ? "2026-09-20" : null,
    }),
  );
  return s;
}

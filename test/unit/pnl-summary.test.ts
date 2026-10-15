import { describe, expect, it } from "vitest";
import { summarizePnl } from "../../src/server/chat/tools/pnl.js";
import type { Strategy } from "../../src/shared/domain.js";

function strategy(patch: Partial<Strategy>): Strategy {
  return {
    id: "s",
    type: "stock",
    currency: "USD",
    description: "",
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

describe("summarizePnl", () => {
  it("groups per currency and never sums across currencies", () => {
    const result = summarizePnl(
      [
        strategy({ id: "a", currency: "USD", brokerPnl: "100.10" }),
        strategy({ id: "b", currency: "USD", brokerPnl: "-20.05" }),
        strategy({ id: "c", currency: "EUR", brokerPnl: "7" }),
      ],
      {},
    );
    expect(result.groups).toEqual([
      expect.objectContaining({
        currency: "EUR",
        group: "all",
        strategies: 1,
        brokerPnl: "7",
      }),
      expect.objectContaining({
        currency: "USD",
        group: "all",
        strategies: 2,
        brokerPnl: "80.05",
      }),
    ]);
  });

  it("counts missing P&L instead of treating it as zero", () => {
    const result = summarizePnl(
      [strategy({ brokerPnl: null }), strategy({ id: "b", brokerPnl: "5" })],
      {},
    );
    expect(result.groups[0]).toMatchObject({
      brokerPnl: "5",
      missingBrokerPnl: 1,
    });
  });

  it("reports an all-null group as null, never zero", () => {
    const result = summarizePnl(
      [strategy({ brokerPnl: null, cashflow: null })],
      {},
    );
    expect(result.groups[0]).toMatchObject({
      brokerPnl: null,
      missingBrokerPnl: 1,
      cashflow: null,
      missingCashflow: 1,
    });
  });

  it("filters by closeDate by default and reports undated exclusions", () => {
    const result = summarizePnl(
      [
        strategy({ id: "in", closeDate: "2026-09-15", brokerPnl: "1" }),
        strategy({ id: "out", closeDate: "2026-10-02", brokerPnl: "2" }),
        strategy({
          id: "open",
          closeDate: null,
          status: "open",
          brokerPnl: null,
        }),
      ],
      { from: "2026-09-01", to: "2026-09-30" },
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ strategies: 1, brokerPnl: "1" });
    expect(result.excludedNoDate).toBe(1);
  });

  it("groups by month of the date field", () => {
    const result = summarizePnl(
      [
        strategy({ id: "a", closeDate: "2026-08-03", brokerPnl: "1" }),
        strategy({ id: "b", closeDate: "2026-09-03", brokerPnl: "2" }),
      ],
      { groupBy: "month" },
    );
    expect(result.groups.map((g) => g.group)).toEqual(["2026-08", "2026-09"]);
  });
});

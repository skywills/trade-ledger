import type {
  Allocation,
  Execution,
  Instrument,
  LedgerSnapshot,
  Projection,
  Strategy,
} from "../../src/shared/domain.js";
export const stock: Instrument = {
  key: "stock",
  assetClass: "STK",
  symbol: "XYZ",
  underlying: null,
  conid: "1",
  expiry: null,
  strike: null,
  putCall: null,
  multiplier: "1",
};
export const put: Instrument = {
  ...stock,
  key: "put",
  assetClass: "OPT",
  underlying: "XYZ",
  conid: "2",
  expiry: "2026-10-16",
  strike: "100",
  putCall: "P",
  multiplier: "100",
};
export const call: Instrument = {
  ...put,
  key: "call",
  conid: "3",
  putCall: "C",
  strike: "105",
  expiry: "2026-11-20",
};
export const protection: Instrument = {
  ...put,
  key: "protection",
  conid: "4",
  strike: "90",
};
export function execution(
  key: string,
  instrument: Instrument,
  quantity: string,
  cash: string,
  day: number,
  action: "open" | "close",
  event: Execution["event"] = "trade",
): Execution {
  return {
    key,
    instrument,
    quantity,
    netCash: cash,
    date: `2026-10-${String(day).padStart(2, "0")}`,
    rawDateTime: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`,
    timezone: "UTC",
    account: "A",
    currency: "USD",
    price: null,
    proceeds: null,
    commission: null,
    taxes: null,
    basis: null,
    brokerPnl: action === "close" ? "0" : null,
    action,
    event,
    brokerIds: {},
    codes: [],
    sources: [{ importId: "imp", rowNumber: day }],
  };
}
export function fixture(
  rows: Array<[string, Execution]>,
  links: Projection["links"] = [],
): { ledger: LedgerSnapshot; projection: Projection } {
  const executions = rows.map(([, e]) => e);
  const strategies: Strategy[] = [...new Set(rows.map(([id]) => id))].map(
    (id) => ({
      id,
      type: id === "put-origin" ? "short_put" : "stock",
      currency: "USD",
      description: id,
      openingDate: "2026-10-01",
      closeDate: null,
      expiry: null,
      expiryYear: null,
      status: "open",
      complete: true,
      openingAmount: null,
      cashflow: null,
      brokerPnl: null,
      reconstructedPnl: null,
      positions: [],
      reasons: [],
    }),
  );
  const allocations: Allocation[] = rows.map(([strategyId, e]) => ({
    strategyId,
    executionKey: e.key,
    quantity: e.quantity,
    netCash: e.netCash,
    brokerPnl: e.brokerPnl,
    pnlEstimated: false,
    role: e.action as "open" | "close",
  }));
  return {
    ledger: {
      id: "ledger",
      inputHash: "h",
      executions,
      lots: [],
      issues: [],
      conflicts: 0,
    },
    projection: {
      ledgerId: "ledger",
      watermark: 0,
      strategies,
      allocations,
      links,
      issues: [],
    },
  };
}
export function assigned(sell = false) {
  return fixture(
    [
      ["put-origin", execution("p-open", put, "-1", "200", 1, "open")],
      [
        "put-origin",
        execution("p-assign", put, "1", "0", 2, "close", "assignment"),
      ],
      [
        "stock-origin",
        execution("s-buy", stock, "100", "-10000", 2, "open", "assignment"),
      ],
      ...(sell
        ? [
            [
              "stock-origin",
              execution("s-sell", stock, "-100", "9650", 8, "close"),
            ] as [string, Execution],
          ]
        : []),
    ],
    [
      {
        from: "put-origin",
        to: "stock-origin",
        type: "assignment",
        sources: [],
      },
    ],
  );
}

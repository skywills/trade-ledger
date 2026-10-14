import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  accountProjection,
  validateProjection,
} from "../../src/server/strategies/accounting.js";
import {
  distributeProportional,
  splitAmount,
} from "../../src/server/strategies/allocation.js";
import type {
  Allocation,
  Execution,
  Instrument,
  Issue,
  LedgerSnapshot,
  Projection,
  Strategy,
} from "../../src/shared/domain.js";
import {
  currencyFractionDigits,
  formatMoney,
  reconcilesWithin,
  UNAVAILABLE,
} from "../../src/shared/money.js";

const instrument: Instrument = {
  key: "conid:1",
  assetClass: "OPT",
  symbol: "TEST",
  underlying: "TEST",
  conid: "1",
  expiry: "2027-01-15",
  strike: "100",
  putCall: "C",
  multiplier: "100",
};

function execution(overrides: Partial<Execution> & { key: string }): Execution {
  return {
    account: "SIM-A",
    instrument,
    date: "2026-09-03",
    rawDateTime: "2026-09-03T10:00:00",
    timezone: null,
    quantity: "+1",
    price: "10",
    currency: "USD",
    netCash: "-1000",
    proceeds: null,
    commission: null,
    taxes: null,
    basis: null,
    brokerPnl: null,
    action: "open",
    event: "trade",
    brokerIds: {},
    codes: [],
    sources: [{ importId: "imp", rowNumber: 1 }],
    ...overrides,
  };
}

function allocation(
  overrides: Partial<Allocation> & { strategyId: string; executionKey: string },
): Allocation {
  return {
    quantity: "1",
    netCash: "-1000",
    brokerPnl: null,
    pnlEstimated: false,
    role: "open",
    ...overrides,
  };
}

function strategy(overrides: Partial<Strategy> & { id: string }): Strategy {
  return {
    type: "long_option",
    currency: "USD",
    description: "TEST long option",
    openingDate: "2026-09-03",
    closeDate: null,
    expiry: "2027-01-15",
    expiryYear: 2027,
    status: "open",
    complete: false,
    openingAmount: null,
    cashflow: null,
    brokerPnl: null,
    reconstructedPnl: null,
    positions: [],
    reasons: [],
    ...overrides,
  };
}

function ledger(
  executions: Execution[],
  conflicts = 0,
  issues: Issue[] = [],
): LedgerSnapshot {
  return {
    id: "ledger-1",
    inputHash: "hash",
    executions,
    lots: [],
    issues,
    conflicts,
  };
}

function projection(
  strategies: Strategy[],
  allocations: Allocation[],
): Projection {
  return {
    ledgerId: "ledger-1",
    watermark: 0,
    strategies,
    allocations,
    links: [],
    issues: [],
  };
}

function sumOf(values: readonly string[]): Decimal {
  return values.reduce((acc, value) => acc.plus(value), new Decimal(0));
}

describe("formatMoney", () => {
  it("formats USD to two decimals and null as Unavailable", () => {
    expect(formatMoney("-451.660745", "USD")).toBe("-451.66");
    expect(formatMoney("-449.212451", "USD")).toBe("-449.21");
    expect(formatMoney(null, "USD")).toBe("Unavailable");
    expect(UNAVAILABLE).toBe("Unavailable");
  });

  it("renders only the number without symbol or grouping", () => {
    expect(formatMoney("1234567.891", "USD")).toBe("1234567.89");
  });

  it("rounds half away from zero on ties", () => {
    expect(formatMoney("0.005", "USD")).toBe("0.01");
    expect(formatMoney("-0.005", "USD")).toBe("-0.01");
    expect(formatMoney("2.675", "USD")).toBe("2.68");
    expect(formatMoney("-2.675", "USD")).toBe("-2.68");
    expect(formatMoney("1.005", "USD")).toBe("1.01");
  });

  it("distinguishes an explicit zero from an unavailable value", () => {
    expect(formatMoney("0", "USD")).toBe("0.00");
    expect(formatMoney(null, "USD")).toBe("Unavailable");
  });

  it("derives fraction digits from currency metadata", () => {
    expect(currencyFractionDigits("USD")).toBe(2);
    expect(currencyFractionDigits("JPY")).toBe(0);
    expect(formatMoney("1234.5", "JPY")).toBe("1235");
  });

  it("reconciles within one display minor unit", () => {
    expect(reconcilesWithin("-451.6607454", "-451.660745", "USD")).toBe(true);
    expect(reconcilesWithin("100.01", "100.00", "USD")).toBe(true);
    expect(reconcilesWithin("100.02", "100.00", "USD")).toBe(false);
  });
});

describe("splitAmount", () => {
  it("conserves the total and assigns the residual to the last strategy id", () => {
    const result = splitAmount("100", [
      { strategyId: "b", quantity: "1" },
      { strategyId: "a", quantity: "1" },
      { strategyId: "c", quantity: "1" },
    ]);

    expect(result.map((part) => part.strategyId)).toEqual(["a", "b", "c"]);
    expect(sumOf(result.map((part) => part.amount)).toFixed()).toBe("100");
    expect(result[0]?.amount).toBe("33.333333333333333333");
    expect(result[1]?.amount).toBe("33.333333333333333333");
    expect(result[2]?.amount).toBe("33.333333333333333334");
  });

  it("does not reverse sign when partitioning negative or short quantities", () => {
    const positive = splitAmount("100", [
      { strategyId: "a", quantity: "-1" },
      { strategyId: "b", quantity: "-3" },
    ]);
    expect(positive.map((part) => part.amount)).toEqual(["25", "75"]);

    const negative = splitAmount("-100", [
      { strategyId: "a", quantity: "-1" },
      { strategyId: "b", quantity: "-3" },
    ]);
    expect(negative.map((part) => part.amount)).toEqual(["-25", "-75"]);
  });

  it("partitions proportionally by magnitude", () => {
    const result = splitAmount("-400", [
      { strategyId: "a", quantity: "1" },
      { strategyId: "b", quantity: "3" },
    ]);
    expect(result.map((part) => part.amount)).toEqual(["-100", "-300"]);
  });
});

describe("distributeProportional", () => {
  it("apportions an amount and labels it estimated", () => {
    const shares = distributeProportional("-451.660745", [
      { strategyId: "a", quantity: "3" },
      { strategyId: "b", quantity: "1" },
    ]);
    expect(shares.every((share) => share.estimated)).toBe(true);
    expect(sumOf(shares.map((share) => share.amount)).toFixed()).toBe(
      "-451.660745",
    );
  });
});

describe("accountProjection", () => {
  it("computes opening, cashflow, broker and reconstructed P/L", () => {
    const open = execution({
      key: "exec:imp:1",
      quantity: "+1",
      netCash: "-1000",
      action: "open",
    });
    const close = execution({
      key: "exec:imp:2",
      quantity: "-1",
      netCash: "1010",
      action: "close",
      brokerPnl: "10",
    });
    const accounted = accountProjection(
      ledger([open, close]),
      projection(
        [strategy({ id: "s1", status: "closed", complete: true })],
        [
          allocation({
            strategyId: "s1",
            executionKey: open.key,
            quantity: "1",
            netCash: "-1000",
            role: "open",
          }),
          allocation({
            strategyId: "s1",
            executionKey: close.key,
            quantity: "-1",
            netCash: "1010",
            brokerPnl: "10",
            role: "close",
          }),
        ],
      ),
    );

    const result = accounted.strategies[0];
    expect(result?.openingAmount).toBe("1000");
    expect(result?.cashflow).toBe("10");
    expect(result?.brokerPnl).toBe("10");
    expect(result?.reconstructedPnl).toBe("10");
    expect(accounted.issues.map((issue) => issue.code)).not.toContain(
      "PNL_RECONCILIATION",
    );
  });

  it("keeps reconstructed P/L null when a basis transfer is present", () => {
    const open = execution({
      key: "exec:imp:1",
      quantity: "+1",
      netCash: "-1000",
    });
    const close = execution({
      key: "exec:imp:2",
      quantity: "-1",
      netCash: "1000",
      action: "close",
      basis: "500",
    });
    const accounted = accountProjection(
      ledger([open, close]),
      projection(
        [strategy({ id: "s1", status: "closed", complete: true })],
        [
          allocation({
            strategyId: "s1",
            executionKey: open.key,
            quantity: "1",
            netCash: "-1000",
            role: "open",
          }),
          allocation({
            strategyId: "s1",
            executionKey: close.key,
            quantity: "-1",
            netCash: "1000",
            role: "close",
          }),
        ],
      ),
    );

    expect(accounted.strategies[0]?.cashflow).toBe("0");
    expect(accounted.strategies[0]?.reconstructedPnl).toBeNull();
  });

  it("suppresses reconstructed P/L when ledger evidence is quarantined", () => {
    const open = execution({ key: "exec:imp:1", netCash: "-1000" });
    const close = execution({
      key: "exec:imp:2",
      quantity: "-1",
      netCash: "1010",
      action: "close",
      brokerPnl: "10",
    });
    const accounted = projection(
      [strategy({ id: "s1", status: "closed", complete: true })],
      [
        allocation({
          strategyId: "s1",
          executionKey: open.key,
          quantity: "1",
          netCash: "-1000",
          role: "open",
        }),
        allocation({
          strategyId: "s1",
          executionKey: close.key,
          quantity: "-1",
          netCash: "1010",
          brokerPnl: "10",
          role: "close",
        }),
      ],
    );

    const quarantined = accountProjection(
      ledger([open, close], 0, [
        {
          key: "ledger:PARSE_ERROR:1",
          code: "PARSE_ERROR",
          sources: [],
          severity: "error",
        },
      ]),
      accounted,
    );
    expect(quarantined.strategies[0]?.cashflow).toBe("10");
    expect(quarantined.strategies[0]?.brokerPnl).toBe("10");
    expect(quarantined.strategies[0]?.reconstructedPnl).toBeNull();

    // Clean evidence still reconstructs the same closed strategy's P/L.
    const clean = accountProjection(ledger([open, close]), accounted);
    expect(clean.strategies[0]?.reconstructedPnl).toBe("10");
  });

  it("flags reconciliation differences beyond one minor unit", () => {
    const build = (brokerPnl: string) => {
      const open = execution({ key: "exec:imp:1", netCash: "-1000" });
      const close = execution({
        key: "exec:imp:2",
        quantity: "-1",
        netCash: "1010",
        action: "close",
        brokerPnl,
      });
      return accountProjection(
        ledger([open, close]),
        projection(
          [strategy({ id: "s1", status: "closed", complete: true })],
          [
            allocation({
              strategyId: "s1",
              executionKey: open.key,
              quantity: "1",
              netCash: "-1000",
              role: "open",
            }),
            allocation({
              strategyId: "s1",
              executionKey: close.key,
              quantity: "-1",
              netCash: "1010",
              brokerPnl,
              role: "close",
            }),
          ],
        ),
      );
    };

    expect(build("10.01").issues.map((issue) => issue.code)).not.toContain(
      "PNL_RECONCILIATION",
    );
    expect(build("9.50").issues.map((issue) => issue.code)).toContain(
      "PNL_RECONCILIATION",
    );
  });

  it("distinguishes an explicit zero broker P/L from an unknown one", () => {
    const open = execution({ key: "exec:imp:1", netCash: "-1000" });
    const allocationsFor = (close: Execution, brokerPnl: string | null) => [
      allocation({
        strategyId: "s1",
        executionKey: open.key,
        quantity: "1",
        netCash: "-1000",
        role: "open",
      }),
      allocation({
        strategyId: "s1",
        executionKey: close.key,
        quantity: "-1",
        netCash: "1000",
        brokerPnl,
        role: "close",
      }),
    ];

    const zeroClose = execution({
      key: "exec:imp:2",
      quantity: "-1",
      netCash: "1000",
      action: "close",
      brokerPnl: "0",
    });
    const zero = accountProjection(
      ledger([open, zeroClose]),
      projection(
        [strategy({ id: "s1", status: "closed", complete: true })],
        allocationsFor(zeroClose, "0"),
      ),
    );
    expect(zero.strategies[0]?.brokerPnl).toBe("0");

    const unknownClose = execution({
      key: "exec:imp:2",
      quantity: "-1",
      netCash: "1000",
      action: "close",
      brokerPnl: null,
    });
    const unknown = accountProjection(
      ledger([open, unknownClose]),
      projection(
        [strategy({ id: "s1", status: "closed", complete: true })],
        allocationsFor(unknownClose, null),
      ),
    );
    expect(unknown.strategies[0]?.brokerPnl).toBeNull();
  });

  it("distributes execution P/L proportionally and marks it estimated", () => {
    const close = execution({
      key: "exec:imp:2",
      quantity: "-2",
      netCash: "2400",
      action: "close",
      brokerPnl: "400",
    });
    const accounted = accountProjection(
      ledger([close]),
      projection(
        [strategy({ id: "s1" }), strategy({ id: "s2" })],
        [
          allocation({
            strategyId: "s1",
            executionKey: close.key,
            quantity: "-1",
            netCash: "1200",
            brokerPnl: null,
            role: "close",
          }),
          allocation({
            strategyId: "s2",
            executionKey: close.key,
            quantity: "-1",
            netCash: "1200",
            brokerPnl: null,
            role: "close",
          }),
        ],
      ),
    );

    expect(accounted.allocations.every((entry) => entry.pnlEstimated)).toBe(
      true,
    );
    expect(
      accounted.allocations.map((entry) => entry.brokerPnl).sort(),
    ).toEqual(["200", "200"]);
    expect(accounted.strategies[0]?.brokerPnl).toBe("200");
    expect(accounted.strategies[0]?.reasons).toContain("ESTIMATED_PNL");
  });
});

describe("validateProjection", () => {
  it("reports over-allocation of an execution as a hard error", () => {
    const exec = execution({
      key: "exec:imp:1",
      quantity: "+2",
      netCash: "-400",
    });
    const issues = validateProjection(
      ledger([exec]),
      projection(
        [strategy({ id: "s1" }), strategy({ id: "s2" })],
        [
          allocation({
            strategyId: "s1",
            executionKey: exec.key,
            quantity: "2",
            netCash: "-400",
            role: "open",
          }),
          allocation({
            strategyId: "s2",
            executionKey: exec.key,
            quantity: "2",
            netCash: "-400",
            role: "open",
          }),
        ],
      ),
    );

    expect(
      issues.some(
        (issue) =>
          issue.code === "ALLOCATION_OVERFLOW" && issue.severity === "error",
      ),
    ).toBe(true);
  });

  it("reports an allocation whose sign contradicts the execution", () => {
    const exec = execution({
      key: "exec:imp:1",
      quantity: "+2",
      netCash: "-400",
    });
    const issues = validateProjection(
      ledger([exec]),
      projection(
        [strategy({ id: "s1" })],
        [
          allocation({
            strategyId: "s1",
            executionKey: exec.key,
            quantity: "-2",
            netCash: "-400",
            role: "open",
          }),
        ],
      ),
    );

    expect(
      issues.some(
        (issue) =>
          issue.code === "ALLOCATION_SIGN_MISMATCH" &&
          issue.severity === "error",
      ),
    ).toBe(true);
  });

  it("flags conflicting evidence as non-definitive", () => {
    const exec = execution({ key: "exec:imp:1" });
    const issues = validateProjection(
      ledger([exec], 1),
      projection(
        [strategy({ id: "s1" })],
        [
          allocation({
            strategyId: "s1",
            executionKey: exec.key,
            quantity: "1",
            netCash: "-1000",
            role: "open",
          }),
        ],
      ),
    );

    expect(
      issues.some(
        (issue) =>
          issue.code === "CONFLICTING_EVIDENCE" && issue.severity === "error",
      ),
    ).toBe(true);
  });

  it("returns no hard errors for a conserved projection", () => {
    const exec = execution({ key: "exec:imp:1" });
    const issues = validateProjection(
      ledger([exec]),
      projection(
        [strategy({ id: "s1" })],
        [
          allocation({
            strategyId: "s1",
            executionKey: exec.key,
            quantity: "1",
            netCash: "-1000",
            role: "open",
          }),
        ],
      ),
    );

    expect(issues.filter((issue) => issue.severity === "error")).toHaveLength(
      0,
    );
  });
});

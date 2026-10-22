import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { accountProjection } from "../../src/server/strategies/accounting.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type { Execution, LedgerSnapshot } from "../../src/shared/domain.js";
import { execution, put } from "../fixtures/lifecycles.js";

function fill(
  key: string,
  quantity: string,
  basis: string,
  cash: string,
  day = 1,
): Execution {
  return {
    ...execution(key, put, quantity, cash, day, day === 1 ? "open" : "close"),
    basis,
    brokerPnl: day === 1 ? "0" : null,
  };
}
function project(rows: Execution[]) {
  const ledger: LedgerSnapshot = {
    id: "ledger",
    inputHash: "input",
    executions: rows,
    lots: [],
    issues: [],
    conflicts: 0,
  };
  return accountProjection(
    ledger,
    groupStrategies(ledger, [], (_account, keys) => keys.join("+")),
  );
}

describe("broker P&L allocated using matched opening basis", () => {
  it("reconciles the SQQQ mixed-lot close while conserving broker rounding", () => {
    const rows = [
      fill("a", "5", "225.48425", "-225.48425"),
      {
        ...fill("b", "4", "120.2674", "-120.2674"),
        brokerIds: { IBOrderID: "july30" },
      },
      {
        ...fill("c", "1", "29.49685", "-29.49685"),
        brokerIds: { IBOrderID: "july30" },
      },
      {
        ...fill("close-a", "-4", "-180.3874", "429.1894304", 2),
        brokerPnl: "248.80203",
      },
      {
        ...fill("close-b", "-4", "-119.6974", "429.1894304", 2),
        brokerPnl: "309.492031",
      },
      {
        ...fill("close-mixed", "-2", "-75.1637", "214.5947152", 2),
        brokerPnl: "139.431016",
      },
    ];
    const result = project(rows);
    expect(result.strategies.map((s) => [s.id, s.status, s.brokerPnl])).toEqual(
      [
        ["a", "closed", "311.0025376"],
        ["b+c", "closed", "386.7225394"],
      ],
    );
    const mixed = result.allocations.filter(
      (a) => a.executionKey === "close-mixed",
    );
    expect(
      mixed.map((a) => [
        a.strategyId,
        a.brokerPnl,
        a.pnlEstimated,
        a.pnlAttribution,
      ]),
    ).toEqual([
      ["a", "62.2005076", false, "basis-reconciled"],
      ["b+c", "77.2305084", false, "basis-reconciled"],
    ]);
    expect(
      mixed
        .reduce((sum, a) => sum.plus(a.brokerPnl ?? 0), new Decimal(0))
        .toFixed(),
    ).toBe("139.431016");
    for (const s of result.strategies) {
      expect(
        new Decimal(s.brokerPnl ?? "0")
          .minus(s.reconstructedPnl ?? "0")
          .abs()
          .lt("0.01"),
      ).toBe(true);
      expect(s.reasons).toContain("BASIS_RECONCILED_PNL");
      expect(s.reasons).not.toContain("ESTIMATED_PNL");
    }
    expect(project([...rows].reverse())).toEqual(result);
  });

  it.each([
    {
      quantities: ["1", "1", "-2"],
      bases: ["10", "30", "-40"],
      cash: ["-10", "-30", "50"],
      pnl: "10",
      expected: ["15", "-5"],
    },
    {
      quantities: ["-1", "-1", "2"],
      bases: ["-10", "-30", "40"],
      cash: ["10", "30", "-50"],
      pnl: "-10",
      expected: ["-15", "5"],
    },
  ] as const)(
    "handles long and short lots, including opposite-sign profits: $quantities",
    ({ quantities, bases, cash, pnl, expected }) => {
      const result = project([
        fill("a", quantities[0], bases[0], cash[0]),
        fill("b", quantities[1], bases[1], cash[1]),
        {
          ...fill("close", quantities[2], bases[2], cash[2], 2),
          brokerPnl: pnl,
        },
      ]);
      expect(
        result.allocations
          .filter((a) => a.role === "close")
          .map((a) => a.brokerPnl),
      ).toEqual(expected);
    },
  );

  it("retains proportional fallback when cash and basis do not explain broker P&L", () => {
    const result = project([
      fill("a", "1", "10", "-10"),
      fill("b", "1", "30", "-30"),
      { ...fill("close", "-2", "-40", "50", 2), brokerPnl: "100" },
    ]);
    expect(
      result.allocations
        .filter((a) => a.role === "close")
        .map((a) => [a.brokerPnl, a.pnlEstimated]),
    ).toEqual([
      ["50", true],
      ["50", true],
    ]);
  });

  it("does not invent P&L when the broker amount is unavailable", () => {
    const result = project([
      fill("a", "1", "10", "-10"),
      fill("b", "1", "30", "-30"),
      fill("close", "-2", "-40", "50", 2),
    ]);
    expect(
      result.allocations
        .filter((a) => a.role === "close")
        .map((a) => a.brokerPnl),
    ).toEqual([null, null]);
  });

  it("retains fallback when strategy quantities are known but opening-fill attribution is ambiguous", () => {
    const rows = [
      { ...fill("a1", "1", "10", "-10"), brokerIds: { IBOrderID: "a" } },
      { ...fill("a2", "1", "20", "-20"), brokerIds: { IBOrderID: "a" } },
      { ...fill("b1", "1", "20", "-20"), brokerIds: { IBOrderID: "b" } },
      { ...fill("b2", "1", "30", "-30"), brokerIds: { IBOrderID: "b" } },
      { ...fill("close", "-2", "-40", "50", 2), brokerPnl: "10" },
    ];
    expect(
      project(rows)
        .allocations.filter((a) => a.role === "close")
        .map((a) => [a.quantity, a.brokerPnl, a.pnlEstimated]),
    ).toEqual([
      ["-1", "5", true],
      ["-1", "5", true],
    ]);
  });
});

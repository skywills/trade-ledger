import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { accountProjection } from "../../src/server/strategies/accounting.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import { basisCloseAllocation } from "../../src/server/strategies/grouping-basis.js";
import { createGroupingContext } from "../../src/server/strategies/grouping-context.js";
import { groupOpenings } from "../../src/server/strategies/grouping-openings.js";
import type { Execution, LedgerSnapshot } from "../../src/shared/domain.js";
import { execution, put } from "../fixtures/lifecycles.js";

const resolveId = (account: string, keys: string[]) =>
  `${account}:${keys.join("+")}`;
const ledger = (executions: Execution[]): LedgerSnapshot => ({
  id: "ledger",
  inputHash: "input",
  executions,
  lots: [],
  issues: [],
  conflicts: 0,
});
function fill(
  key: string,
  quantity: string,
  basis: string | null,
  day: number,
  action: "open" | "close",
): Execution {
  return {
    ...execution(
      key,
      put,
      quantity,
      new Decimal(quantity).times(-50).toFixed(),
      day,
      action,
    ),
    basis,
  };
}

describe("basis-supported close allocation", () => {
  it("releases the full opening basis when its per-contract cost repeats", () => {
    const close = fill("close", "-12", "-10", 2, "close");
    close.netCash = "4";
    close.brokerPnl = "-6";
    const result = groupStrategies(
      ledger([
        fill("a", "3", "1", 1, "open"),
        fill("b", "9", "9", 1, "open"),
        close,
      ]),
      [],
      resolveId,
    );
    expect(
      result.allocations
        .filter((a) => a.role === "close")
        .map((a) => a.brokerPnl),
    ).toEqual(["0", "-6"]);
  });
  it("uses chronological FIFO among equal-basis option fills and preserves the later reported lot", () => {
    const older = fill("z-first", "1", "100", 1, "open");
    const newer = fill("a-second", "1", "100", 2, "open");
    older.brokerIds = newer.brokerIds = { IBOrderID: "one" };
    const first = fill("sale", "-1", "-100", 3, "close");
    const last = fill("last", "-1", "-100", 4, "close");
    last.brokerIds = { TradeID: "last" };
    const input = ledger([older, newer, first, last]);
    input.lots.push({
      kind: "lot",
      rowNumber: 1,
      issues: [],
      section: null,
      fields: {
        ClientAccountID: "A",
        TradeID: "last",
        OpenDateTime: newer.rawDateTime,
        Quantity: "-1",
      },
    });
    expect(
      groupStrategies(input, [], resolveId).strategies.map((s) => s.status),
    ).toEqual(["closed"]);
  });

  it.each(["tied", "incomparable"])(
    "retains the proven strategy P&L without choosing a %s equal-basis fill",
    (chronology) => {
      const a = fill("a", "1", "10", 1, "open");
      const a2 = fill("a2", "1", "10", 1, "open");
      a.brokerIds = a2.brokerIds = { IBOrderID: "one" };
      if (chronology === "incomparable") {
        a2.rawDateTime = a2.date;
      }
      const other = fill("b", "1", "20", 1, "open");
      const close = fill("close", "-2", "-30", 5, "close");
      close.brokerPnl = "70";
      const input = ledger([a, a2, other, close]);
      const context = createGroupingContext(input, [], resolveId);
      groupOpenings(context);
      const part = basisCloseAllocation(context, close, close.quantity)?.find(
        (p) => p.draft.id === "A:a+a2",
      );
      expect(part).toMatchObject({ quantity: "-1", lots: undefined });
      expect(
        groupStrategies(input, [], resolveId)
          .allocations.filter((a) => a.role === "close")
          .map((a) => [a.strategyId, a.brokerPnl, a.pnlAttribution]),
      ).toEqual([
        ["A:a+a2", "40", "basis-reconciled"],
        ["A:b", "30", "basis-reconciled"],
      ]);
    },
  );
  it("uses a unique basis match with source rounding to select a short opening", () => {
    const a = fill("a", "-1", "-101.0000004", 1, "open");
    const b = fill("b", "-1", "-120.2", 1, "open");
    const close = fill("close", "1", "101.000000", 2, "close");
    const result = groupStrategies(ledger([b, close, a]), [], resolveId);
    expect(result.issues).toEqual([]);
    expect(
      result.allocations.find((row) => row.executionKey === "close"),
    ).toMatchObject({ strategyId: "A:a", quantity: "1" });
  });

  it("splits a close across lots only for a unique basis allocation and preserves residuals and cash", () => {
    const rows = [
      fill("a", "3", "30", 1, "open"),
      fill("b", "2", "40", 1, "open"),
      fill("c", "1", "35", 1, "open"),
      {
        ...fill("close-first", "-4", "-75", 2, "close"),
        netCash: "199.1234567",
        brokerPnl: "124.1234567",
      },
      {
        ...fill("close-last", "-2", "-30", 3, "close"),
        netCash: "100.9876543",
        brokerPnl: "70.9876543",
      },
    ];
    const input = ledger(rows);
    const result = groupStrategies(input, [], resolveId);
    expect(result.issues).toEqual([]);
    expect(result.strategies.map((s) => s.status)).toEqual([
      "closed",
      "closed",
      "closed",
    ]);
    expect(
      result.allocations
        .filter((a) => a.executionKey === "close-first")
        .map((a) => [a.strategyId, a.quantity]),
    ).toEqual([
      ["A:a", "-2"],
      ["A:b", "-1"],
      ["A:c", "-1"],
    ]);
    for (const execution of rows) {
      const allocated = result.allocations.filter(
        (a) => a.executionKey === execution.key,
      );
      expect(
        allocated
          .reduce((sum, a) => sum.plus(a.quantity), new Decimal(0))
          .eq(execution.quantity),
      ).toBe(true);
      expect(
        allocated
          .reduce((sum, a) => sum.plus(a.netCash), new Decimal(0))
          .eq(execution.netCash),
      ).toBe(true);
    }
    const accounted = accountProjection(input, result);
    expect(
      accounted.allocations
        .filter((a) => a.role === "close")
        .every(
          (a) => !a.pnlEstimated && a.pnlAttribution === "basis-reconciled",
        ),
    ).toBe(true);
    expect(groupStrategies(ledger([...rows].reverse()), [], resolveId)).toEqual(
      result,
    );
  });

  it("tracks remaining basis across multiple opening fills in one broker order", () => {
    const grouped = (row: Execution): Execution => ({
      ...row,
      brokerIds: { IBOrderID: "grouped-open" },
    });
    const rows = [
      fill("a", "3", "30", 1, "open"),
      grouped(fill("b", "2", "40", 1, "open")),
      grouped(fill("c", "1", "35", 1, "open")),
      fill("close-first", "-4", "-75", 2, "close"),
      fill("close-last", "-2", "-30", 3, "close"),
    ];
    const result = groupStrategies(ledger(rows), [], resolveId);
    expect(result.issues).toEqual([]);
    expect(result.strategies.map((s) => s.status)).toEqual([
      "closed",
      "closed",
    ]);
    expect(
      result.allocations
        .filter((a) => a.executionKey === "close-first")
        .map((a) => [a.strategyId, a.quantity]),
    ).toEqual([
      ["A:a", "-2"],
      ["A:b+c", "-2"],
    ]);
    for (const execution of rows) {
      const allocations = result.allocations.filter(
        (a) => a.executionKey === execution.key,
      );
      expect(
        allocations
          .reduce((sum, a) => sum.plus(a.netCash), new Decimal(0))
          .eq(execution.netCash),
      ).toBe(true);
    }
  });

  it("keeps roll links for every opening lot consumed by a split close", () => {
    const a = fill("a", "1", "10", 1, "open");
    const b = fill("b", "1", "20", 1, "open");
    const close = {
      ...fill("close", "-2", "-30", 2, "close"),
      brokerIds: { IBOrderID: "roll" },
    };
    const reopen = {
      ...fill("reopen", "2", "40", 2, "open"),
      instrument: {
        ...put,
        key: "replacement",
        conid: "replacement",
        expiry: "2026-11-20",
      },
      brokerIds: { IBOrderID: "roll" },
    };
    const result = groupStrategies(
      ledger([a, b, close, reopen]),
      [],
      resolveId,
    );
    expect(
      result.links
        .filter((link) => link.type === "roll")
        .map((link) => [link.from, link.to])
        .sort(),
    ).toEqual([
      ["A:a", "A:reopen"],
      ["A:b", "A:reopen"],
    ]);
  });

  it("treats equal-basis fills in one strategy as interchangeable", () => {
    const grouped = (key: string) => ({
      ...fill(key, "1", "10", 1, "open"),
      brokerIds: { IBOrderID: "same-order" },
    });
    const result = groupStrategies(
      ledger([
        grouped("a"),
        grouped("a2"),
        fill("b", "1", "20", 1, "open"),
        fill("close", "-2", "-30", 2, "close"),
      ]),
      [],
      resolveId,
    );
    expect(result.issues).toEqual([]);
    expect(
      result.allocations
        .filter((a) => a.executionKey === "close")
        .map((a) => [a.strategyId, a.quantity]),
    ).toEqual([
      ["A:a+a2", "-1"],
      ["A:b", "-1"],
    ]);
  });

  it("does not override ambiguous basis evidence with a single whole-close candidate", () => {
    const result = groupStrategies(
      ledger([
        fill("a", "2", "20", 1, "open"),
        fill("b", "1", "20", 1, "open"),
        fill("c", "1", "20", 1, "open"),
        fill("close", "-2", "-30", 2, "close"),
      ]),
      [],
      resolveId,
    );
    expect(result.issues.map((i) => i.code)).toContain("AMBIGUOUS_CLOSE");
    expect(
      result.allocations.find((a) => a.executionKey === "close")?.strategyId,
    ).not.toBe("A:a");
  });

  it("preserves the established tie-break for fully equivalent whole opening lots", () => {
    const a = { ...fill("a", "1", "10", 1, "open"), price: "0.1" };
    const b = { ...fill("b", "1", "10", 1, "open"), price: "0.1" };
    const close = { ...fill("close", "-1", "-10", 2, "close"), price: "0.2" };
    const result = groupStrategies(ledger([b, close, a]), [], resolveId);
    expect(result.issues).toEqual([]);
    expect(
      result.allocations.find((a) => a.executionKey === "close")?.strategyId,
    ).toBe("A:a");
  });

  it("does not invent strategy ambiguity from uncertain fill attribution inside one strategy", () => {
    const openings = ["8", "12", "10", "10"].map((basis, index) => ({
      ...fill(`open-${index}`, "1", basis, 1, "open"),
      brokerIds: { IBOrderID: "one-strategy" },
    }));
    const result = groupStrategies(
      ledger([
        ...openings,
        fill("first-close", "-2", "-20", 2, "close"),
        fill("last-close", "-2", "-20", 3, "close"),
      ]),
      [],
      resolveId,
    );
    expect(result.issues).toEqual([]);
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]?.status).toBe("closed");
  });

  it("proves a unique strategy allocation even when different basis fills can supply it", () => {
    const grouped = ["20", "40", "60"].map((basis, index) => ({
      ...fill(`grouped-${index}`, "2", basis, 1, "open"),
      brokerIds: { IBOrderID: "grouped-order" },
    }));
    const result = groupStrategies(
      ledger([
        ...grouped,
        fill("other", "1", "1000", 1, "open"),
        fill("close", "-2", "-40", 2, "close"),
      ]),
      [],
      resolveId,
    );
    expect(result.issues).toEqual([]);
    expect(
      result.allocations
        .filter((a) => a.executionKey === "close")
        .map((a) => [a.strategyId, a.quantity]),
    ).toEqual([["A:grouped-0+grouped-1+grouped-2", "-2"]]);
  });

  it("does not reuse uncertain fill provenance as proof for a later cross-strategy choice", () => {
    const grouped = ["20", "40", "60"].map((basis, index) => ({
      ...fill(`grouped-${index}`, "2", basis, 1, "open"),
      brokerIds: { IBOrderID: "grouped-order" },
    }));
    const result = groupStrategies(
      ledger([
        ...grouped,
        fill("other", "1", "1000", 1, "open"),
        fill("first-close", "-2", "-40", 2, "close"),
        fill("later-close", "-1", "-20", 3, "close"),
      ]),
      [],
      resolveId,
    );
    expect(
      result.allocations.find((a) => a.executionKey === "first-close")
        ?.strategyId,
    ).toBe("A:grouped-0+grouped-1+grouped-2");
    expect(result.issues.map((i) => i.code)).toEqual(["AMBIGUOUS_CLOSE"]);
    expect(
      result.allocations.find((a) => a.executionKey === "later-close")
        ?.strategyId,
    ).toBe("A:later-close");
  });

  it("keeps multiple valid basis allocations unresolved", () => {
    const result = groupStrategies(
      ledger([
        fill("a", "2", "20", 1, "open"),
        fill("b", "2", "20", 1, "open"),
        fill("close", "-2", "-20", 2, "close"),
      ]),
      [],
      resolveId,
    );
    expect(result.issues.map((i) => i.code)).toContain("AMBIGUOUS_CLOSE");
  });

  it("does not invent a split when basis is missing", () => {
    const result = groupStrategies(
      ledger([
        fill("a", "1", "10", 1, "open"),
        fill("b", "1", "20", 1, "open"),
        fill("close", "-2", null, 2, "close"),
      ]),
      [],
      resolveId,
    );
    expect(result.strategies.some((s) => s.status === "unresolved")).toBe(true);
  });
});

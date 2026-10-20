import { Decimal } from "decimal.js";
import { expect, it } from "vitest";
import { computeProjection } from "../../src/server/builds/service.js";
import type { LedgerSnapshot } from "../../src/shared/domain.js";
import { execution, put } from "../fixtures/lifecycles.js";
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
      ).toMatchObject({ brokerPnl: allocation.brokerPnl, estimated: true });
    }
    expect(
      result.issues.filter((issue) => issue.code === "LIFECYCLE_CONSERVATION"),
    ).toEqual([]);
  } finally {
    await dispose();
  }
});

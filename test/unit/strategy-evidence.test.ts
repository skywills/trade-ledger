import { expect, it } from "vitest";
import { selectStrategyEvidence } from "../../src/server/strategies/evidence.js";
import type { Allocation } from "../../src/shared/domain.js";
import { execution, snapshot } from "../fixtures/analytics.js";

it("retains allocation sources but withholds a closing lot shared by two strategies", () => {
  const ledger = snapshot().ledger;
  ledger.executions = [
    execution({
      key: "close",
      quantity: "-2",
      brokerIds: { TradeID: "T" },
      sources: [{ importId: "file", rowNumber: 110 }],
    }),
  ];
  ledger.lots = [
    {
      rowNumber: 111,
      source: { importId: "file", rowNumber: 111 },
      section: null,
      fields: { TradeID: "T", ClientAccountID: "SIM" },
      kind: "lot",
      issues: [],
    },
  ];
  const allocations: Allocation[] = ["stock-one", "stock-two"].map(
    (strategyId) => ({
      strategyId,
      executionKey: "close",
      quantity: "-1",
      netCash: "50",
      brokerPnl: null,
      pnlEstimated: false,
      role: "close",
    }),
  );
  const evidence = selectStrategyEvidence(ledger, allocations, "stock-one");
  expect(evidence.executions).toEqual(ledger.executions);
  expect(evidence.lots).toEqual([]);
  expect(evidence.ambiguousLotCount).toBe(1);
});

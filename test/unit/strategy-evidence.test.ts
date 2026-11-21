import { expect, it } from "vitest";
import { selectStrategyEvidence } from "../../src/server/strategies/evidence.js";
import type { Allocation } from "../../src/shared/domain.js";
import { execution, snapshot } from "../fixtures/analytics.js";

it("includes inferred closes when matching lots by contract and time", () => {
  const ledger = snapshot().ledger;
  const rawDateTime = "2026-09-20T12:00:00";
  const inferred = execution({
    key: "inferred",
    rawDateTime,
    action: "unknown",
    event: "expiry",
    instrument: { ...execution().instrument, conid: "123" },
  });
  const lot = {
    source: { importId: "csv", rowNumber: 3 },
    rowNumber: 3,
    section: null,
    fields: {
      ClientAccountID: "SIM",
      CurrencyPrimary: "USD",
      Conid: "123",
      DateTime: rawDateTime,
    },
    kind: "lot" as const,
    issues: [],
  };
  const allocation: Allocation = {
    strategyId: "first",
    executionKey: inferred.key,
    quantity: "-1",
    netCash: "50",
    brokerPnl: null,
    pnlEstimated: false,
    role: "close",
  };
  ledger.lots = [lot];
  ledger.executions = [inferred];
  expect(selectStrategyEvidence(ledger, [allocation], "first").lots).toEqual([
    lot,
  ]);
  ledger.executions.push({ ...inferred, key: "explicit", action: "close" });
  const allocations = [
    allocation,
    { ...allocation, strategyId: "second", executionKey: "explicit" },
  ];
  for (const id of ["first", "second"])
    expect(selectStrategyEvidence(ledger, allocations, id)).toMatchObject({
      lots: [],
      ambiguousLotCount: 1,
    });
  // An unallocated, inferred close still makes the other execution ambiguous.
  expect(
    selectStrategyEvidence(ledger, allocations.slice(1), "second").lots,
  ).toEqual([]);
});

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

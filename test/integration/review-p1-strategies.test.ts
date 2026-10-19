import { describe, expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  computeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  groupExplicitInput,
  groupMergeInput,
  manualAllocationInput,
} from "../../src/server/decisions/schemas.js";
import {
  appendDecision,
  type Decision,
  decisionWatermark,
  readDecisions,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { normalizeLedger } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import {
  accountProjection,
  validateProjection,
} from "../../src/server/strategies/accounting.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type { LedgerSnapshot } from "../../src/shared/domain.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const { store, dispose } = await createTestStore();
  try {
    await run(store);
  } finally {
    await dispose();
  }
}

async function importExecutions(
  store: Store,
  executions: Uint8Array,
  timezone: string | null = "UTC",
): Promise<string> {
  const preview = await previewImport(store, {
    filename: "review-p1-strategies.csv",
    bytes: executions,
    timezone,
  });
  const imported = await commitImport(store, preview.id);
  return imported.importId;
}

function stockExecution(args: {
  id: string;
  date: string;
  time?: string;
  quantity: string;
  cash: string;
  account?: string;
  currency?: string;
  role?: "O" | "C";
}) {
  return executionRow({
    ClientAccountID: args.account ?? "SIM-A",
    AssetClass: "STK",
    Symbol: "TEST",
    Conid: "12345",
    CurrencyPrimary: args.currency ?? "USD",
    TradeDate: args.date,
    DateTime: `${args.date} ${args.time ?? "12:00:00"}`,
    Quantity: args.quantity,
    NetCash: args.cash,
    TradeID: args.id,
    IBExecID: args.id,
    BrokerageOrderID: args.id,
    Multiplier: "1",
    "Notes/Codes": args.role ?? (args.quantity.startsWith("-") ? "C" : "O"),
  });
}

function optionExecution(args: {
  id: string;
  order: string;
  date: string;
  strike: string;
  quantity: string;
  cash: string;
  role: "O" | "C";
}) {
  return executionRow({
    ClientAccountID: "SIM-A",
    AssetClass: "OPT",
    Symbol: "TEST",
    UnderlyingSymbol: "TEST",
    Conid: `OPT-${args.strike}`,
    CurrencyPrimary: "USD",
    TradeDate: args.date,
    DateTime: `${args.date} 10:00:00`,
    Quantity: args.quantity,
    TradePrice: "1",
    NetCash: args.cash,
    "Notes/Codes": args.role,
    IBOrderID: args.order,
    BrokerageOrderID: args.order,
    IBExecID: args.id,
    TradeID: args.id,
    Expiry: "2026-10-16",
    Strike: args.strike,
    "Put/Call": "P",
    Multiplier: "100",
  });
}

function resolveId(account: string, keys: string[]): string {
  return `${account}:${[...keys].sort().join(",")}`;
}

function decision(
  kind: string,
  payload: Record<string, unknown>,
  sequence: number,
): Decision {
  return {
    id: `decision-${sequence}`,
    sequence,
    kind,
    sources: [],
    strategyIds: [],
    payload,
    supersedesId: null,
    clientRequestId: `request-${sequence}`,
    author: "test",
    createdAt: "2026-10-14T00:00:00.000Z",
  };
}

describe("P1 strategy chronology and merge boundaries", () => {
  it.each([
    {
      name: "a close on an earlier date",
      openingDate: "2026-10-10",
      openingTime: "12:00:00",
      closingDate: "2026-10-01",
      closingTime: "12:00:00",
    },
    {
      name: "a close earlier on the same date",
      openingDate: "2026-10-01",
      openingTime: "15:00:00",
      closingDate: "2026-10-01",
      closingTime: "09:00:00",
    },
  ])("does not match $name to the only known opening", async (case_) =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "future-open",
            date: case_.openingDate,
            time: case_.openingTime,
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "earlier-close",
            date: case_.closingDate,
            time: case_.closingTime,
            quantity: "-1",
            cash: "120",
          }),
        ]),
      );

      const result = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const projection = groupStrategies(result, [], resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(
        projection.strategies.some(
          (strategy) => strategy.status === "unresolved" && !strategy.complete,
        ),
      ).toBe(true);
      expect(
        projection.strategies.some(
          (strategy) =>
            strategy.status === "open" &&
            strategy.openingDate === case_.openingDate,
        ),
      ).toBe(true);
    }),
  );

  it("counts earlier same-time closes when checking the remaining opening quantity", async () =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "two-open",
            date: "2026-10-01",
            time: "09:00:00",
            quantity: "2",
            cash: "-200",
          }),
          stockExecution({
            id: "close-a",
            date: "2026-10-02",
            time: "10:00:00",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "close-b",
            date: "2026-10-02",
            time: "10:00:00",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "close-c",
            date: "2026-10-02",
            time: "10:00:00",
            quantity: "-1",
            cash: "110",
          }),
        ]),
      );
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const projection = groupStrategies(ledger, [], resolveId);
      const opening = ledger.executions.find(
        (execution) => execution.brokerIds.TradeID === "two-open",
      );
      if (opening === undefined)
        throw new Error("Expected the opening execution");
      const openingStrategyId = projection.allocations.find(
        (allocation) => allocation.executionKey === opening.key,
      )?.strategyId;
      const matchedCloseQuantity = projection.allocations
        .filter(
          (allocation) =>
            allocation.strategyId === openingStrategyId &&
            allocation.quantity.startsWith("-"),
        )
        .reduce((sum, allocation) => sum + Number(allocation.quantity), 0);

      expect(Math.abs(matchedCloseQuantity)).toBe(2);
      expect(projection.issues.map((issue) => issue.code)).toContain(
        "MISSING_OPENING",
      );
      expect(
        projection.strategies.find(
          (strategy) => strategy.id === openingStrategyId,
        )?.positions[0]?.quantity,
      ).toBe("0");
    }));

  it("does not spend an opening twice when close time certainty is mixed", async () =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "open",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "a-late",
            date: "2026-10-03",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "c-early",
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
        ]),
        "UTC",
      );
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "b-unknown",
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
        ]),
        null,
      );

      const result = await rebuild(store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("active");
      const projection = activeProjection(store).projection;
      if (projection === null) throw new Error("Expected active projection");
      const openingAllocation = projection.allocations.find((allocation) =>
        allocation.executionKey.includes("trade:open"),
      );
      if (openingAllocation === undefined)
        throw new Error("Expected opening allocation");
      const openingStrategy = projection.strategies.find(
        (strategy) => strategy.id === openingAllocation.strategyId,
      );
      if (openingStrategy === undefined)
        throw new Error("Expected opening strategy");
      const matchedCloseQuantity = projection.allocations
        .filter(
          (allocation) =>
            allocation.strategyId === openingStrategy.id &&
            allocation.quantity.startsWith("-"),
        )
        .reduce((sum, allocation) => sum + Number(allocation.quantity), 0);

      expect(Math.abs(matchedCloseQuantity)).toBe(1);
      expect(openingStrategy.positions[0]?.quantity).toBe("0");
    }));

  it("does not use a future assigned close to fabricate earlier short exposure", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "open1",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "open2",
            date: "2026-10-03",
            quantity: "2",
            cash: "-200",
          }),
          stockExecution({
            id: "close3",
            date: "2026-10-04",
            quantity: "-3",
            cash: "300",
          }),
          stockExecution({
            id: "early-buy-close",
            date: "2026-10-02",
            quantity: "1",
            cash: "-100",
            role: "C",
          }),
        ]),
      );
      await rebuild(store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      let watermark = decisionWatermark(store);
      for (const rowNumber of [2, 3, 4]) {
        await appendDecision(
          store,
          groupExplicitInput({
            strategyId: "known-long",
            source: { importId, rowNumber },
          }),
          watermark++,
        );
      }

      const result = await rebuild(store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("active");
      const projection = activeProjection(store).projection;
      if (projection === null) throw new Error("Expected active projection");
      const earlyBuyClose = projection.allocations.find((allocation) =>
        allocation.executionKey.includes("early-buy-close"),
      );

      expect(earlyBuyClose?.strategyId).not.toBe("known-long");
      expect(
        projection.strategies.find((strategy) => strategy.id === "known-long")
          ?.positions[0]?.quantity,
      ).toBe("0");
    }));

  it("uses known replenishment before a reserved close to fund an earlier close", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "trajectory-open1",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "trajectory-close1",
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "trajectory-open2",
            date: "2026-10-03",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "trajectory-close2",
            date: "2026-10-04",
            quantity: "-1",
            cash: "110",
          }),
        ]),
      );
      await storeBuild(store);
      await explicitlyGroupRows(store, importId, [2, 4, 5], "trajectory-group");

      const result = await rebuild(store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("active");
      const projection = activeProjection(store).projection;
      if (projection === null) throw new Error("Expected active projection");
      const group = projection.strategies.find(
        (strategy) => strategy.id === "trajectory-group",
      );
      const firstClose = projection.allocations.find((allocation) =>
        allocation.executionKey.includes("trajectory-close1"),
      );

      expect(firstClose?.strategyId).toBe("trajectory-group");
      expect(group?.status).toBe("closed");
      expect(group?.complete).toBe(true);
      expect(group?.positions[0]?.quantity).toBe("0");
      expect(group?.cashflow).toBe("20");
      expect(group?.reconstructedPnl).toBe("20");
    }));

  it("does not let replenishment after a reserved close release earlier capacity", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "late-open1",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "late-early-close",
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "late-reserved-close",
            date: "2026-10-04",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "late-replenishment",
            date: "2026-10-05",
            quantity: "1",
            cash: "-100",
          }),
        ]),
      );
      await storeBuild(store);
      await explicitlyGroupRows(store, importId, [2, 4, 5], "late-group");
      const result = await rebuild(store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("active");
      const projection = activeProjection(store).projection;
      if (projection === null) throw new Error("Expected active projection");
      const earlyClose = projection.allocations.find((allocation) =>
        allocation.executionKey.includes("late-early-close"),
      );

      expect(earlyClose?.strategyId).not.toBe("late-group");
    }));

  it("does not fund a reserved close with a timezone-uncertain opening", async () =>
    withStore(async (store) => {
      const knownImportId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "unknown-open1",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "unknown-early-close",
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "unknown-reserved-close",
            date: "2026-10-06",
            quantity: "-1",
            cash: "110",
          }),
        ]),
      );
      const uncertainImportId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "uncertain-replenishment",
            date: "2026-10-05",
            quantity: "1",
            cash: "-100",
          }),
        ]),
        null,
      );
      await storeBuild(store);
      await explicitlyGroupRows(store, knownImportId, [2, 4], "unknown-group");
      await explicitlyGroupRows(store, uncertainImportId, [2], "unknown-group");
      const result = await rebuild(store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("active");
      const projection = activeProjection(store).projection;
      if (projection === null) throw new Error("Expected active projection");
      const earlyClose = projection.allocations.find((allocation) =>
        allocation.executionKey.includes("unknown-early-close"),
      );

      expect(earlyClose?.strategyId).not.toBe("unknown-group");
    }));

  it("reserves separate capacity for known and uncertain future closes", async () =>
    withStore(async (store) => {
      const knownImportId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "mixed-open",
            date: "2026-10-01",
            quantity: "2",
            cash: "-200",
          }),
          stockExecution({
            id: "mixed-automatic-close",
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
          stockExecution({
            id: "mixed-known-reserved-close",
            date: "2026-10-03",
            quantity: "-1",
            cash: "110",
          }),
        ]),
      );
      const uncertainImportId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "mixed-uncertain-reserved-close",
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
        ]),
        null,
      );
      await storeBuild(store);
      await explicitlyGroupRows(store, knownImportId, [2, 4], "mixed-group");
      await explicitlyGroupRows(store, uncertainImportId, [2], "mixed-group");
      const result = await rebuild(store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      expect(result.status).toBe("active");
      const projection = activeProjection(store).projection;
      if (projection === null) throw new Error("Expected active projection");
      const automaticClose = projection.allocations.find((allocation) =>
        allocation.executionKey.includes("mixed-automatic-close"),
      );
      const mixedGroup = projection.strategies.find(
        (strategy) => strategy.id === "mixed-group",
      );

      expect(automaticClose?.strategyId).not.toBe("mixed-group");
      expect(mixedGroup?.positions[0]?.quantity).toBe("0");
    }));

  it(
    "orders a large same-time close set with conserved opening exposure",
    async () =>
      withStore(async (store) => {
        const manyCloses = Array.from({ length: 1_500 }, (_, index) =>
          stockExecution({
            id: `same-close-${String(index).padStart(4, "0")}`,
            date: "2026-10-02",
            quantity: "-1",
            cash: "110",
          }),
        );
        await importExecutions(
          store,
          buildExecutionTable([
            stockExecution({
              id: "scale-open",
              date: "2026-10-01",
              quantity: "1",
              cash: "-100",
            }),
            ...manyCloses,
          ]),
        );
        const ledger = await normalizeLedger(store, {
          parserVersion: "flex-v1",
          decisionWatermark: 0,
        });
        const projection = groupStrategies(ledger, [], resolveId);
        const opening = ledger.executions.find(
          (execution) => execution.brokerIds.TradeID === "scale-open",
        );
        if (opening === undefined)
          throw new Error("Expected opening execution");
        const openingStrategyId = projection.allocations.find(
          (allocation) => allocation.executionKey === opening.key,
        )?.strategyId;
        if (openingStrategyId === undefined)
          throw new Error("Expected opening strategy allocation");
        const matchedCloseCount = projection.allocations.filter(
          (allocation) =>
            allocation.strategyId === openingStrategyId &&
            allocation.quantity.startsWith("-"),
        ).length;

        expect(matchedCloseCount).toBe(1);
        expect(
          projection.strategies.find(
            (strategy) => strategy.id === openingStrategyId,
          )?.positions[0]?.quantity,
        ).toBe("0");
      }),
    // This is a conservation regression, not a performance benchmark. V8
    // coverage instrumentation adds substantial work to its 1,500-row fixture.
    20_000,
  );

  it("leaves an apparent match unresolved when timezone ordering is unavailable", async () =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "open",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "close",
            date: "2026-10-02",
            quantity: "-1",
            cash: "120",
          }),
        ]),
      );
      const normalized = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const uncertain = {
        ...normalized,
        executions: normalized.executions.map((execution) => ({
          ...execution,
          timezone: null,
          rawDateTime: execution.date,
          sources: execution.sources.map((source) => ({
            ...source,
            importId: execution.key,
          })),
        })),
      };

      const projection = groupStrategies(uncertain, [], resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(
        projection.strategies.some(
          (strategy) => strategy.status === "unresolved" && !strategy.complete,
        ),
      ).toBe(true);
      expect(projection.issues.map((issue) => issue.code)).toContain(
        "MISSING_OPENING",
      );
    }));

  it("uses shared report wall-clock order when the report has no timezone", async () =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "open",
            date: "2026-10-01",
            time: "09:00:00",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "close",
            date: "2026-10-02",
            time: "10:00:00",
            quantity: "-1",
            cash: "120",
          }),
        ]),
      );
      const normalized = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const unzonedReport = {
        ...normalized,
        executions: normalized.executions.map((execution) => ({
          ...execution,
          timezone: null,
        })),
      };

      const projection = groupStrategies(unzonedReport, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.status).toBe("closed");
      expect(projection.strategies[0]?.complete).toBe(true);
    }));

  it("closes Scenario A across separate no-timezone opening and closing imports", async () =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          optionExecution({
            id: "open-short-put",
            order: "OPEN-SPREAD",
            date: "2026-09-03",
            strike: "100",
            quantity: "-1",
            cash: "200",
            role: "O",
          }),
          optionExecution({
            id: "open-long-put",
            order: "OPEN-SPREAD",
            date: "2026-09-03",
            strike: "95",
            quantity: "1",
            cash: "-50",
            role: "O",
          }),
        ]),
        null,
      );
      await importExecutions(
        store,
        buildExecutionTable([
          optionExecution({
            id: "close-short-put",
            order: "CLOSE-SPREAD",
            date: "2026-09-25",
            strike: "100",
            quantity: "1",
            cash: "-100",
            role: "C",
          }),
          optionExecution({
            id: "close-long-put",
            order: "CLOSE-SPREAD",
            date: "2026-09-25",
            strike: "95",
            quantity: "-1",
            cash: "20",
            role: "C",
          }),
        ]),
        null,
      );
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.type).toBe("bull_put_spread");
      expect(projection.strategies[0]?.status).toBe("closed");
      expect(projection.strategies[0]?.complete).toBe(true);
      expect(projection.strategies[0]?.closeDate).toBe("2026-09-25");
    }));

  it("does not merge retained strategy groups with different currencies", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "usd",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "eur",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            currency: "EUR",
          }),
        ]),
      );
      await storeBuild(store);
      const before = (
        await computeProjection(
          store,
          await normalizeLedger(store, {
            parserVersion: "flex-v1",
            decisionWatermark: 0,
          }),
          0,
        )
      ).strategies;
      const usd = before.find((strategy) => strategy.currency === "USD");
      const eur = before.find((strategy) => strategy.currency === "EUR");
      expect(usd).toBeDefined();
      expect(eur).toBeDefined();
      if (usd === undefined || eur === undefined)
        throw new Error("Expected USD and EUR strategies");

      const ledger: LedgerSnapshot = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const decisions: Decision[] = [
        decision(
          "group_explicit",
          { strategyId: usd.id, source: { importId, rowNumber: 2 } },
          1,
        ),
        decision(
          "group_explicit",
          { strategyId: eur.id, source: { importId, rowNumber: 3 } },
          2,
        ),
        decision(
          "group_merge",
          { chosenStrategyId: usd.id, mergedStrategyIds: [eur.id] },
          3,
        ),
      ];

      const projection = groupStrategies(ledger, decisions, resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(
        projection.strategies.map((strategy) => strategy.currency).sort(),
      ).toEqual(["EUR", "USD"]);
      expect(projection.issues.map((issue) => issue.code)).toContain(
        "INCOMPATIBLE_STRATEGY_MERGE",
      );
      expect(
        validateProjection(ledger, projection).map((issue) => issue.code),
      ).toContain("INCOMPATIBLE_STRATEGY_MERGE");
    }));

  it("does not combine incompatible groups through a retained merge target with no current draft", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "usd",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "eur",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            currency: "EUR",
          }),
        ]),
      );
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const decisions: Decision[] = [
        decision(
          "group_explicit",
          { strategyId: "usd-group", source: { importId, rowNumber: 2 } },
          1,
        ),
        decision(
          "group_explicit",
          { strategyId: "eur-group", source: { importId, rowNumber: 3 } },
          2,
        ),
        decision(
          "group_merge",
          {
            chosenStrategyId: "retained-empty-target",
            mergedStrategyIds: ["usd-group"],
          },
          3,
        ),
        decision(
          "group_merge",
          {
            chosenStrategyId: "retained-empty-target",
            mergedStrategyIds: ["eur-group"],
          },
          4,
        ),
      ];

      const projection = groupStrategies(ledger, decisions, resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(
        projection.strategies.map((strategy) => strategy.currency).sort(),
      ).toEqual(["EUR", "USD"]);
      expect(projection.issues.map((issue) => issue.code)).toContain(
        "INCOMPATIBLE_STRATEGY_MERGE",
      );
    }));

  it("suppresses totals and exposure for an incompatible strategy allocation set", async () =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "usd",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "eur",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            currency: "EUR",
          }),
        ]),
      );
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const grouped = groupStrategies(ledger, [], resolveId);
      const chosen = grouped.strategies.find(
        (strategy) => strategy.currency === "USD",
      );
      if (chosen === undefined) throw new Error("Expected USD strategy");
      const incompatible = {
        ...grouped,
        strategies: [chosen],
        allocations: grouped.allocations.map((allocation) => ({
          ...allocation,
          strategyId: chosen.id,
        })),
      };

      const accounted = accountProjection(ledger, incompatible);

      expect(accounted.strategies[0]?.status).toBe("unresolved");
      expect(accounted.strategies[0]?.positions).toEqual([]);
      expect(accounted.strategies[0]?.cashflow).toBeNull();
      expect(accounted.issues.map((issue) => issue.code)).toContain(
        "INCOMPATIBLE_STRATEGY_MEMBERSHIP",
      );
      expect(
        validateProjection(ledger, incompatible).map((issue) => issue.code),
      ).toContain("INCOMPATIBLE_STRATEGY_MEMBERSHIP");
    }));

  it("rejects a new retained merge across currency boundaries", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "usd",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "eur",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            currency: "EUR",
          }),
        ]),
      );
      await storeBuild(store);
      const projection = await computeProjection(
        store,
        await normalizeLedger(store, {
          parserVersion: "flex-v1",
          decisionWatermark: 0,
        }),
        0,
      );
      const usd = projection.strategies.find(
        (strategy) => strategy.currency === "USD",
      );
      const eur = projection.strategies.find(
        (strategy) => strategy.currency === "EUR",
      );
      if (usd === undefined || eur === undefined)
        throw new Error("Expected USD and EUR strategies");
      const watermark = decisionWatermark(store);
      await appendDecision(
        store,
        groupExplicitInput({
          strategyId: usd.id,
          source: { importId, rowNumber: 2 },
        }),
        watermark,
      );
      await appendDecision(
        store,
        groupExplicitInput({
          strategyId: eur.id,
          source: { importId, rowNumber: 3 },
        }),
        decisionWatermark(store),
      );

      await expect(
        appendDecision(
          store,
          groupMergeInput({
            chosenStrategyId: usd.id,
            mergedStrategyIds: [eur.id],
          }),
          decisionWatermark(store),
        ),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_STRATEGY_MERGE" });
      expect(readDecisions(store, decisionWatermark(store))).toHaveLength(2);
    }));

  it("rejects explicit membership that assigns a different currency to an existing strategy", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "usd",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "eur",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            currency: "EUR",
          }),
        ]),
      );
      await storeBuild(store);
      const projection = await computeProjection(
        store,
        await normalizeLedger(store, {
          parserVersion: "flex-v1",
          decisionWatermark: 0,
        }),
        0,
      );
      const usd = projection.strategies.find(
        (strategy) => strategy.currency === "USD",
      );
      if (usd === undefined) throw new Error("Expected USD strategy");

      await expect(
        appendDecision(
          store,
          groupExplicitInput({
            strategyId: usd.id,
            source: { importId, rowNumber: 3 },
          }),
          decisionWatermark(store),
        ),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_STRATEGY_MEMBERSHIP" });
      expect(readDecisions(store, decisionWatermark(store))).toHaveLength(0);
    }));

  it("rejects a manual allocation that crosses the strategy currency boundary", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "usd",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "eur",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            currency: "EUR",
          }),
        ]),
      );
      await storeBuild(store);
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const projection = await computeProjection(store, ledger, 0);
      const usd = projection.strategies.find(
        (strategy) => strategy.currency === "USD",
      );
      const eurExecution = ledger.executions.find(
        (execution) => execution.currency === "EUR",
      );
      if (usd === undefined || eurExecution === undefined)
        throw new Error("Expected USD strategy and EUR execution");

      await expect(
        appendDecision(
          store,
          manualAllocationInput({
            strategyId: usd.id,
            source: { importId, rowNumber: 2 },
            allocations: [
              {
                executionKey: eurExecution.key,
                quantity: "1",
                netCash: "-200",
                brokerPnl: null,
              },
            ],
          }),
          decisionWatermark(store),
        ),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_STRATEGY_MEMBERSHIP" });
      expect(readDecisions(store, decisionWatermark(store))).toHaveLength(0);
    }));

  it("rejects mixed account or currency allocations when creating a new strategy", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "new-usd",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "new-eur",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            currency: "EUR",
          }),
        ]),
      );
      await storeBuild(store);
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const usd = ledger.executions.find(
        (execution) => execution.currency === "USD",
      );
      const eur = ledger.executions.find(
        (execution) => execution.currency === "EUR",
      );
      if (usd === undefined || eur === undefined)
        throw new Error("Expected USD and EUR executions");

      await expect(
        appendDecision(
          store,
          manualAllocationInput({
            strategyId: "new-manual-strategy",
            source: { importId, rowNumber: 2 },
            allocations: [
              {
                executionKey: usd.key,
                quantity: "1",
                netCash: "-100",
                brokerPnl: null,
              },
              {
                executionKey: eur.key,
                quantity: "1",
                netCash: "-200",
                brokerPnl: null,
              },
            ],
          }),
          decisionWatermark(store),
        ),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_STRATEGY_MEMBERSHIP" });
      expect(readDecisions(store, decisionWatermark(store))).toHaveLength(0);
    }));

  it("allows a merge when both strategies belong to the same account and currency", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "first",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
          }),
          stockExecution({
            id: "second",
            date: "2026-10-02",
            quantity: "1",
            cash: "-200",
          }),
        ]),
      );
      await storeBuild(store);
      const projection = await computeProjection(
        store,
        await normalizeLedger(store, {
          parserVersion: "flex-v1",
          decisionWatermark: 0,
        }),
        0,
      );
      expect(projection.strategies).toHaveLength(2);
      const [chosen, merged] = projection.strategies;
      if (chosen === undefined || merged === undefined)
        throw new Error("Expected two strategies");
      let watermark = decisionWatermark(store);
      await appendDecision(
        store,
        groupExplicitInput({
          strategyId: chosen.id,
          source: { importId, rowNumber: 2 },
        }),
        watermark++,
      );
      await appendDecision(
        store,
        groupExplicitInput({
          strategyId: merged.id,
          source: { importId, rowNumber: 3 },
        }),
        watermark++,
      );
      await appendDecision(
        store,
        groupMergeInput({
          chosenStrategyId: chosen.id,
          mergedStrategyIds: [merged.id],
        }),
        watermark,
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: decisionWatermark(store),
      });
      const result = groupStrategies(
        ledger,
        readDecisions(store, decisionWatermark(store)),
        resolveId,
      );
      expect(result.strategies).toHaveLength(1);
      expect(result.issues.map((issue) => issue.code)).not.toContain(
        "INCOMPATIBLE_STRATEGY_MERGE",
      );
    }));

  it("rejects a merge across accounts even when currencies match", async () =>
    withStore(async (store) => {
      await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "account-a",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
            account: "SIM-A",
          }),
          stockExecution({
            id: "account-b",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            account: "SIM-B",
          }),
        ]),
      );
      await storeBuild(store);
      const projection = await computeProjection(
        store,
        await normalizeLedger(store, {
          parserVersion: "flex-v1",
          decisionWatermark: 0,
        }),
        0,
      );
      const [chosen, merged] = projection.strategies;
      if (chosen === undefined || merged === undefined)
        throw new Error("Expected two account strategies");

      await expect(
        appendDecision(
          store,
          groupMergeInput({
            chosenStrategyId: chosen.id,
            mergedStrategyIds: [merged.id],
          }),
          decisionWatermark(store),
        ),
      ).rejects.toMatchObject({ code: "INCOMPATIBLE_STRATEGY_MERGE" });
      expect(readDecisions(store, decisionWatermark(store))).toHaveLength(0);
    }));

  it("keeps different accounts separate when replaying retained merges", async () =>
    withStore(async (store) => {
      const importId = await importExecutions(
        store,
        buildExecutionTable([
          stockExecution({
            id: "account-a",
            date: "2026-10-01",
            quantity: "1",
            cash: "-100",
            account: "SIM-A",
          }),
          stockExecution({
            id: "account-b",
            date: "2026-10-01",
            quantity: "1",
            cash: "-200",
            account: "SIM-B",
          }),
        ]),
      );
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const decisions: Decision[] = [
        decision(
          "group_explicit",
          { strategyId: "account-a", source: { importId, rowNumber: 2 } },
          1,
        ),
        decision(
          "group_explicit",
          { strategyId: "account-b", source: { importId, rowNumber: 3 } },
          2,
        ),
        decision(
          "group_merge",
          {
            chosenStrategyId: "empty-account-target",
            mergedStrategyIds: ["account-a"],
          },
          3,
        ),
        decision(
          "group_merge",
          {
            chosenStrategyId: "empty-account-target",
            mergedStrategyIds: ["account-b"],
          },
          4,
        ),
      ];

      const projection = groupStrategies(ledger, decisions, resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(projection.issues.map((issue) => issue.code)).toContain(
        "INCOMPATIBLE_STRATEGY_MERGE",
      );
      expect(
        validateProjection(ledger, projection).map((issue) => issue.code),
      ).toContain("INCOMPATIBLE_STRATEGY_MERGE");
    }));
});

async function storeBuild(store: Store): Promise<void> {
  // Create the active build required by durable decision validation.
  const { rebuild } = await import("../../src/server/builds/service.js");
  await rebuild(store, {
    mode: "full",
    parserVersion: "flex-v1",
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
}

async function explicitlyGroupRows(
  store: Store,
  importId: string,
  rowNumbers: readonly number[],
  strategyId: string,
): Promise<void> {
  let watermark = decisionWatermark(store);
  for (const rowNumber of rowNumbers) {
    await appendDecision(
      store,
      groupExplicitInput({
        strategyId,
        source: { importId, rowNumber },
      }),
      watermark++,
    );
  }
}

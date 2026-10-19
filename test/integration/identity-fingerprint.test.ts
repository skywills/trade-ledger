import { describe, expect, it } from "vitest";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { normalizeLedger } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import {
  buildExecutionTable,
  type ExecutionFields,
  executionRow,
} from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const { store, dispose } = await createTestStore();
  try {
    await run(store);
  } finally {
    await dispose();
  }
}

async function commitRows(
  store: Store,
  filename: string,
  rows: ExecutionFields[],
  timezone: string | null = "UTC",
): Promise<void> {
  const preview = await previewImport(store, {
    filename,
    bytes: buildExecutionTable(rows.map(executionRow)),
    timezone,
  });
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
}

function stock(
  tradeId: string,
  overrides: ExecutionFields = {},
): ExecutionFields {
  return {
    ClientAccountID: "SIM-R04",
    AssetClass: "STK",
    Symbol: "TEST",
    UnderlyingSymbol: "TEST",
    Conid: "1",
    CurrencyPrimary: "USD",
    TradeDate: "2026-01-15",
    DateTime: "2026-01-15 10:00:00",
    Quantity: "+10",
    TradePrice: "5",
    Proceeds: "-50",
    IBCommission: "-1",
    NetCash: "-51",
    "Notes/Codes": "O",
    Multiplier: "1",
    IBExecID: `EX-${tradeId}`,
    TradeID: tradeId,
    ...overrides,
  };
}

function option(
  tradeId: string,
  overrides: ExecutionFields = {},
): ExecutionFields {
  return {
    ClientAccountID: "SIM-R04",
    AssetClass: "OPT",
    Symbol: "AXON  261016C00490000",
    UnderlyingSymbol: "AXON",
    Conid: "9000470",
    CurrencyPrimary: "USD",
    TradeDate: "2026-01-15",
    DateTime: "2026-01-15 10:00:00",
    Quantity: "-1",
    TradePrice: "2.5",
    Proceeds: "250",
    IBCommission: "-1",
    NetCash: "249",
    "Notes/Codes": "O",
    Expiry: "2026-10-16",
    Strike: "490",
    "Put/Call": "C",
    IBExecID: `EX-${tradeId}`,
    TradeID: tradeId,
    ...overrides,
  };
}

async function ledgerOf(store: Store) {
  return normalizeLedger(store, {
    parserVersion: "flex-v1",
    decisionWatermark: 0,
  });
}

describe("identity fingerprint uses broker-stable fields only (R04)", () => {
  it("deduplicates an overlapping re-export uploaded with a different timezone", async () =>
    withStore(async (store) => {
      await commitRows(store, "january.csv", [stock("T1")], "America/New_York");
      await commitRows(
        store,
        "jan-feb.csv",
        [
          stock("T1"),
          stock("T2", {
            TradeDate: "2026-02-02",
            DateTime: "2026-02-02 11:00:00",
          }),
        ],
        null,
      );

      const ledger = await ledgerOf(store);
      expect(
        ledger.issues.filter((issue) => issue.code === "identity_conflict"),
      ).toEqual([]);
      expect(ledger.conflicts).toBe(0);
      const t1 = ledger.executions.find(
        (execution) => execution.brokerIds.TradeID === "T1",
      );
      expect(t1?.sources).toHaveLength(2);
      expect(ledger.executions).toHaveLength(2);
    }));

  it.each([
    ["sparse first", false],
    ["full first", true],
  ])(
    "keeps a broker-reported amount only one export carries (%s)",
    async (_, fullFirst) =>
      withStore(async (store) => {
        const sparse = [stock("T1")];
        const full = [
          stock("T1", { FifoPnlRealized: "12.5", CostBasis: "50" }),
        ];
        await commitRows(store, "a.csv", fullFirst ? full : sparse);
        await commitRows(store, "b.csv", fullFirst ? sparse : full);

        const ledger = await ledgerOf(store);
        expect(ledger.conflicts).toBe(0);
        const t1 = ledger.executions.find(
          (execution) => execution.brokerIds.TradeID === "T1",
        );
        expect(t1?.sources).toHaveLength(2);
        expect(t1?.brokerPnl).toBe("12.5");
        expect(t1?.basis).toBe("50");
      }),
  );

  it("deduplicates a re-export whose codes order and decimal formatting differ", async () =>
    withStore(async (store) => {
      await commitRows(store, "first.csv", [
        stock("T1", { "Notes/Codes": "O;P", TradePrice: "5" }),
      ]);
      await commitRows(store, "second.csv", [
        stock("T1", {
          "Notes/Codes": "P;O",
          TradePrice: "5.00",
          CostBasis: "50",
        }),
        stock("T2", { DateTime: "2026-01-15 12:00:00" }),
      ]);

      const ledger = await ledgerOf(store);
      expect(ledger.conflicts).toBe(0);
      const t1 = ledger.executions.find(
        (execution) => execution.brokerIds.TradeID === "T1",
      );
      expect(t1?.sources).toHaveLength(2);
    }));

  it("deduplicates an option whose inferred multiplier differs between exports", async () =>
    withStore(async (store) => {
      // With Proceeds the multiplier is inferred as 100; without it, none is.
      await commitRows(store, "with-proceeds.csv", [option("O1")]);
      await commitRows(store, "without-proceeds.csv", [
        option("O1", { Proceeds: "" }),
        option("O2", { DateTime: "2026-01-15 12:00:00" }),
      ]);

      const ledger = await ledgerOf(store);
      expect(ledger.conflicts).toBe(0);
      const o1 = ledger.executions.find(
        (execution) => execution.brokerIds.TradeID === "O1",
      );
      expect(o1?.sources).toHaveLength(2);
    }));

  it("still flags a different quantity on the same TradeID", async () =>
    withStore(async (store) => {
      await commitRows(store, "one.csv", [stock("T1")]);
      await commitRows(store, "two.csv", [stock("T1", { Quantity: "+20" })]);

      const ledger = await ledgerOf(store);
      expect(ledger.conflicts).toBe(1);
      expect(ledger.executions).toHaveLength(0);
      const conflict = ledger.issues.find(
        (issue) => issue.code === "identity_conflict",
      );
      expect(conflict?.sources).toHaveLength(2);
    }));

  it("still flags a different price on the same TradeID", async () =>
    withStore(async (store) => {
      await commitRows(store, "one.csv", [stock("T1")]);
      await commitRows(store, "two.csv", [stock("T1", { TradePrice: "5.5" })]);

      const ledger = await ledgerOf(store);
      expect(ledger.conflicts).toBe(1);
      expect(ledger.executions).toHaveLength(0);
    }));
});

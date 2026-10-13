import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  normalizeLedger,
  readLedger,
} from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import { recordDecision } from "../../src/server/storage/decisions.js";
import {
  buildExecutionTable,
  type ExecutionFields,
  executionRow,
  fixtures,
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

async function commitBytes(
  store: Store,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const preview = await previewImport(store, {
    filename,
    bytes,
    timezone: "UTC",
  });
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
  return committed.importId;
}

/** Simulates a broker re-export: identical rows delivered in a different order. */
function reexported(bytes: Uint8Array): Uint8Array {
  const lines = new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line !== "");
  const [header = "", ...rows] = lines;
  return new TextEncoder().encode([header, ...rows.reverse()].join("\n"));
}

function base(account: string): ExecutionFields {
  return {
    ClientAccountID: account,
    AssetClass: "STK",
    Symbol: "TEST",
    UnderlyingSymbol: "TEST",
    Conid: "1",
    CurrencyPrimary: "USD",
    TradeDate: "2026-09-03",
    DateTime: "2026-09-03 10:00:00",
    TradePrice: "5",
    "Notes/Codes": "O",
    Multiplier: "1",
  };
}

function axonOpen(
  strike: string,
  conid: string,
  quantity: string,
  netCash: string,
  execId: string,
  tradeId: string,
): ExecutionFields {
  return {
    ClientAccountID: "SIM-A",
    AssetClass: "OPT",
    Symbol: "AXON",
    UnderlyingSymbol: "AXON",
    Conid: conid,
    CurrencyPrimary: "USD",
    TradeDate: "2026-09-03",
    DateTime: "2026-09-03 10:00:00",
    Quantity: quantity,
    TradePrice: strike === "470" ? "14.02" : "16.87",
    NetCash: netCash,
    "Notes/Codes": "O",
    IBOrderID: "OPEN-SPREAD",
    BrokerageOrderID: "BROKER-OPEN-SPREAD",
    IBExecID: execId,
    TradeID: tradeId,
    Expiry: "2026-10-16",
    Strike: strike,
    "Put/Call": "P",
    Multiplier: "100",
  };
}

describe("ledger normalization", () => {
  it("deduplicates re-exported partial fills into two executions totaling +4 (scenario C)", async () =>
    withStore(async (store) => {
      await commitBytes(store, "fills.csv", fixtures.partialFills);
      await commitBytes(
        store,
        "fills-reexport.csv",
        reexported(fixtures.partialFills),
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      const vixQuantity = ledger.executions
        .filter((execution) => execution.instrument.underlying === "VIX")
        .reduce(
          (quantity, execution) => quantity.plus(execution.quantity),
          new Decimal(0),
        );
      expect(vixQuantity.toString()).toBe("4");
      expect(ledger.executions.map((execution) => execution.key)).toHaveLength(
        2,
      );
      expect(
        ledger.executions.map((execution) => execution.sources.length),
      ).toEqual([2, 2]);
      expect(ledger.conflicts).toBe(0);
    }));

  it("keeps one broker TradeID repeated under another account as separate transactions", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "cross.csv",
        buildExecutionTable([
          executionRow({
            ...base("SIM-A"),
            Symbol: "AXON",
            UnderlyingSymbol: "AXON",
            IBExecID: "EXEC-SHARED-A",
            TradeID: "TRADE-SHARED",
            Quantity: "+1",
            NetCash: "-100",
          }),
          executionRow({
            ...base("SIM-D"),
            Symbol: "TSLA",
            UnderlyingSymbol: "TSLA",
            IBExecID: "EXEC-SHARED-D",
            TradeID: "TRADE-SHARED",
            Quantity: "-1",
            NetCash: "200",
          }),
        ]),
      );

      const sameTradeIdOtherAccount = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(sameTradeIdOtherAccount.executions).toHaveLength(2);
      expect(
        new Set(
          sameTradeIdOtherAccount.executions.map(
            (execution) => execution.account,
          ),
        ),
      ).toEqual(new Set(["SIM-A", "SIM-D"]));
      const [first, second] = sameTradeIdOtherAccount.executions;
      expect(first?.key).not.toBe(second?.key);
      expect(sameTradeIdOtherAccount.issues).toHaveLength(0);
    }));

  it("unifies an execution-only re-export with its TradeID through nonconflicting alias evidence", async () =>
    withStore(async (store) => {
      const fillsImportId = await commitBytes(
        store,
        "fills.csv",
        fixtures.partialFills,
      );
      const execOnlyImportId = await commitBytes(
        store,
        "fills-execid-only.csv",
        buildExecutionTable([
          executionRow({
            ClientAccountID: "SIM-C",
            AssetClass: "OPT",
            Symbol: "VIX",
            UnderlyingSymbol: "VIX",
            Conid: "9200001",
            CurrencyPrimary: "USD",
            TradeDate: "2026-09-03",
            DateTime: "2026-09-03 10:00:00",
            Quantity: "+2",
            TradePrice: "1.25",
            NetCash: "-250",
            "Notes/Codes": "O",
            IBOrderID: "ORDER-C",
            BrokerageOrderID: "BROKER-PARTIAL",
            IBExecID: "EXEC-C-1",
            Expiry: "2026-10-16",
            Strike: "100",
            "Put/Call": "P",
            Multiplier: "100",
          }),
        ]),
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(2);
      const merged = ledger.executions.find(
        (execution) => execution.brokerIds.IBExecID === "EXEC-C-1",
      );
      expect(merged?.sources.map((source) => source.importId).sort()).toEqual(
        [fillsImportId, execOnlyImportId].sort(),
      );
      const vixQuantity = ledger.executions.reduce(
        (quantity, execution) => quantity.plus(execution.quantity),
        new Decimal(0),
      );
      expect(vixQuantity.toString()).toBe("4");
    }));

  it("keeps supporting booked lot rows separate from executions", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(4);
      expect(ledger.lots).toHaveLength(2);
      expect(ledger.lots.every((lot) => lot.kind === "lot")).toBe(true);
      expect(ledger.lots[0]?.fields["Notes/Codes"]).toBe("ST");
      expect(ledger.lots[0]?.fields["FifoPnlRealized"]).toBe("2418.647637");
      expect(
        ledger.executions.filter((execution) => execution.brokerPnl !== null),
      ).toHaveLength(2);
      expect(ledger.issues).toHaveLength(0);
    }));

  it("applies corrections and cancellations only through explicit references", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "revisions.csv",
        buildExecutionTable([
          executionRow({
            ...base("SIM-R"),
            IBExecID: "ER-1",
            TradeID: "T1",
            Quantity: "+10",
            NetCash: "-100",
          }),
          executionRow({
            ...base("SIM-R"),
            IBExecID: "ER-2",
            TradeID: "T2",
            Quantity: "+12",
            NetCash: "-120",
            OrigTradeID: "T1",
          }),
          executionRow({
            ...base("SIM-R"),
            IBExecID: "ER-4",
            TradeID: "T4",
            Quantity: "+7",
            NetCash: "-70",
          }),
          executionRow({
            ...base("SIM-R"),
            IBExecID: "ER-5",
            TradeID: "T5",
            Quantity: "0",
            NetCash: "0",
            OrigTradeID: "T4",
          }),
        ]),
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(1);
      expect(ledger.executions[0]?.key).toBe("txn:SIM-R:trade:T1");
      expect(ledger.executions[0]?.quantity).toBe("12");
      expect(ledger.executions[0]?.netCash).toBe("-120");
      const revisions = store.db
        .prepare(
          `SELECT logical_transaction_key, revision_number, revision_state
           FROM transaction_revisions WHERE ledger_build_id = ?
           ORDER BY logical_transaction_key, revision_number`,
        )
        .all(ledger.id);
      expect(revisions).toEqual([
        {
          logical_transaction_key: "txn:SIM-R:trade:T1",
          revision_number: 1,
          revision_state: "superseded",
        },
        {
          logical_transaction_key: "txn:SIM-R:trade:T1",
          revision_number: 2,
          revision_state: "active",
        },
        {
          logical_transaction_key: "txn:SIM-R:trade:T4",
          revision_number: 1,
          revision_state: "cancelled",
        },
        {
          logical_transaction_key: "txn:SIM-R:trade:T4",
          revision_number: 2,
          revision_state: "cancelled",
        },
      ]);
      expect(ledger.issues).toHaveLength(0);
    }));

  it("keeps a correction with an unresolvable reference as its own transaction with a warning", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "dangling.csv",
        buildExecutionTable([
          executionRow({
            ...base("SIM-R"),
            IBExecID: "ER-7",
            TradeID: "T7",
            Quantity: "+3",
            NetCash: "-15",
            OrigTradeID: "T-UNKNOWN",
          }),
        ]),
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(1);
      expect(ledger.executions[0]?.quantity).toBe("3");
      const warning = ledger.issues.find(
        (issue) => issue.code === "unresolved_revision_reference",
      );
      expect(warning?.severity).toBe("warning");
      expect(warning?.sources).toHaveLength(1);
    }));

  it("keeps executions active when a later reporting window omits them", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await commitBytes(
        store,
        "opens-later-window.csv",
        buildExecutionTable([
          executionRow(
            axonOpen(
              "470",
              "9000470",
              "+1",
              "-1402.23006",
              "EXEC-A-1",
              "TRADE-A-1",
            ),
          ),
          executionRow(
            axonOpen(
              "480",
              "9000480",
              "-1",
              "1686.7318978",
              "EXEC-A-2",
              "TRADE-A-2",
            ),
          ),
        ]),
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(4);
      expect(
        ledger.executions.filter(
          (execution) => execution.date === "2026-09-25",
        ),
      ).toHaveLength(2);
      const opens = ledger.executions.filter(
        (execution) => execution.date === "2026-09-03",
      );
      expect(opens).toHaveLength(2);
      expect(opens.every((execution) => execution.sources.length === 2)).toBe(
        true,
      );
    }));

  it("holds conflicting payloads for review without a silently active replacement", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "one.csv",
        buildExecutionTable([
          executionRow({
            ...base("SIM-X"),
            IBExecID: "ER-9",
            TradeID: "T9",
            Quantity: "+1",
            NetCash: "-100",
          }),
        ]),
      );
      await commitBytes(
        store,
        "two.csv",
        buildExecutionTable([
          executionRow({
            ...base("SIM-X"),
            IBExecID: "ER-9",
            TradeID: "T9",
            Quantity: "+2",
            NetCash: "-200",
          }),
        ]),
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(0);
      expect(ledger.conflicts).toBe(1);
      const conflict = ledger.issues.find(
        (issue) => issue.code === "identity_conflict",
      );
      expect(conflict?.severity).toBe("error");
      expect(conflict?.sources).toHaveLength(2);
    }));

  it("preserves broker IDs with leading zeros as distinct string identities", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "zeros.csv",
        buildExecutionTable([
          executionRow({
            ...base("SIM-Z"),
            IBExecID: "ER-0451",
            TradeID: "0451",
            Quantity: "+1",
            NetCash: "-10",
          }),
          executionRow({
            ...base("SIM-Z"),
            IBExecID: "ER-451",
            TradeID: "451",
            Quantity: "+2",
            NetCash: "-20",
          }),
        ]),
      );

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(2);
      const leadingZero = ledger.executions.find(
        (execution) => execution.brokerIds.TradeID === "0451",
      );
      const plain = ledger.executions.find(
        (execution) => execution.brokerIds.TradeID === "451",
      );
      expect(leadingZero?.quantity).toBe("1");
      expect(plain?.quantity).toBe("2");
      expect(leadingZero?.key).not.toBe(plain?.key);
    }));

  it("removes only an excluded import's contribution through a retained reversible decision", async () =>
    withStore(async (store) => {
      const fillsImportId = await commitBytes(
        store,
        "fills.csv",
        fixtures.partialFills,
      );
      await commitBytes(store, "roll.csv", fixtures.roll);
      const baseline = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      expect(baseline.executions).toHaveLength(4);

      const exclusion = await recordDecision(store, {
        kind: "import_exclusion",
        payload: { importId: fillsImportId },
        author: "user",
      });
      const excluded = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: exclusion.sequence,
      });
      expect(excluded.executions).toHaveLength(2);
      expect(
        excluded.executions.every(
          (execution) =>
            execution.account === "SIM-C" &&
            execution.instrument.symbol === "XYZ",
        ),
      ).toBe(true);

      const inclusion = await recordDecision(store, {
        kind: "import_inclusion",
        payload: { importId: fillsImportId },
        supersedesId: exclusion.id,
        author: "user",
      });
      const restored = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: inclusion.sequence,
      });
      expect(restored.executions).toHaveLength(4);

      const retainedRows = store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM import_rows WHERE import_id = ?",
        )
        .get(fillsImportId) as { count: number };
      expect(retainedRows.count).toBe(2);
    }));

  it("reproduces identical financial content and source references on full re-normalization", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const first = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const second = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(second.id).not.toBe(first.id);
      expect(second.inputHash).toBe(first.inputHash);
      expect(second.executions).toEqual(first.executions);
      expect(second.lots).toEqual(first.lots);
      expect(second.issues).toEqual(first.issues);
      expect(second.conflicts).toBe(first.conflicts);
      expect(readLedger(store, first.id)).toEqual(first);
      expect(readLedger(store, second.id)).toEqual(second);
    }));

  it("rejects unknown parser versions with VERSION_UNAVAILABLE", async () =>
    withStore(async (store) => {
      await expect(
        normalizeLedger(store, {
          parserVersion: "flex-v0",
          decisionWatermark: 0,
        }),
      ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      expect(ledger.executions).toEqual([]);
      expect(ledger.lots).toEqual([]);
      expect(ledger.issues).toEqual([]);
      expect(ledger.conflicts).toBe(0);
    }));
});

import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { computeProjection } from "../../src/server/builds/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { normalizeLedger } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import { createTestStore } from "../helpers/store.js";

const headers = [
  "ClientAccountID",
  "AssetClass",
  "Symbol",
  "UnderlyingSymbol",
  "Conid",
  "CurrencyPrimary",
  "TradeDate",
  "DateTime",
  "Quantity",
  "TradePrice",
  "NetCash",
  "Notes/Codes",
  "IBExecID",
  "TradeID",
  "OrigTradeID",
  "LevelOfDetail",
];

function row(
  account: string,
  quantity: string,
  tradeId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ClientAccountID: account,
    AssetClass: "STK",
    Symbol: "TEST",
    UnderlyingSymbol: "TEST",
    Conid: "123",
    CurrencyPrimary: "USD",
    TradeDate: "2026-09-03",
    DateTime: "2026-09-03 10:00:00",
    Quantity: quantity,
    TradePrice: "5",
    NetCash: "-5",
    "Notes/Codes": "O",
    TradeID: tradeId,
    LevelOfDetail: "EXECUTION",
    ...extra,
  };
}

function csv(rows: Record<string, string>[]): Uint8Array {
  const values = [headers.join(",")];
  for (const fields of rows) {
    values.push(
      headers
        .map((header) => {
          const value = fields[header] ?? "";
          return value.includes(",") || value.includes('"')
            ? `"${value.replaceAll('"', '""')}"`
            : value;
        })
        .join(","),
    );
  }
  return new TextEncoder().encode(values.join("\n"));
}

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
  rows: Record<string, string>[],
): Promise<string> {
  const preview = await previewImport(store, {
    filename,
    bytes: csv(rows),
    timezone: "UTC",
  });
  return (await commitImport(store, preview.id)).importId;
}

function renameImport(store: Store, oldId: string, newId: string): void {
  store.db.exec("PRAGMA defer_foreign_keys = ON");
  store.db.transaction(() => {
    store.db
      .prepare("UPDATE import_rows SET import_id = ? WHERE import_id = ?")
      .run(newId, oldId);
    store.db
      .prepare("UPDATE imports SET id = ? WHERE id = ?")
      .run(newId, oldId);
  })();
}

describe("P1 ledger evidence regressions", () => {
  it("resolves multi-hop corrections by dependency across source order", async () =>
    withStore(async (store) => {
      await commitRows(store, "t1.csv", [row("SIM-A", "1", "T1")]);
      const t2 = await commitRows(store, "t2.csv", [
        row("SIM-A", "2", "T2", { OrigTradeID: "T1" }),
      ]);
      const t3 = await commitRows(store, "t3.csv", [
        row("SIM-A", "3", "T3", { OrigTradeID: "T2" }),
      ]);
      // Force T3 to sort before T2 while T1 remains the root source.
      renameImport(store, t2, "z-source");
      renameImport(store, t3, "a-source");

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(1);
      expect(ledger.executions[0]?.key).toBe("txn:SIM-A:trade:T1");
      expect(ledger.executions[0]?.quantity).toBe("3");
      expect(
        ledger.executions
          .reduce(
            (sum, execution) => sum.plus(execution.quantity),
            new Decimal(0),
          )
          .toString(),
      ).toBe("3");
      const revisions = store.db
        .prepare(
          `SELECT revision_number, revision_state FROM transaction_revisions
           WHERE ledger_build_id = ? AND logical_transaction_key = ?
           ORDER BY revision_number`,
        )
        .all(ledger.id, "txn:SIM-A:trade:T1");
      expect(revisions).toEqual([
        { revision_number: 1, revision_state: "superseded" },
        { revision_number: 2, revision_state: "superseded" },
        { revision_number: 3, revision_state: "active" },
      ]);
      expect(ledger.issues).toHaveLength(0);
    }));

  it("holds missing and cyclic correction chains without dropping valid originals", async () =>
    withStore(async (store) => {
      await commitRows(store, "chains.csv", [
        row("SIM-A", "1", "T1"),
        row("SIM-A", "4", "T4", { OrigTradeID: "UNKNOWN" }),
        row("SIM-A", "2", "T2", { OrigTradeID: "T3" }),
        row("SIM-A", "3", "T3", { OrigTradeID: "T2" }),
        row("SIM-A", "5", "T5"),
        row("SIM-B", "6", "T6", { OrigTradeID: "T1" }),
      ]);

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(
        ledger.executions.map((execution) => execution.key).sort(),
      ).toEqual(["txn:SIM-A:trade:T1", "txn:SIM-A:trade:T5"]);
      expect(
        ledger.issues
          .filter((issue) => issue.code === "unresolved_revision_reference")
          .map((issue) => issue.severity),
      ).toEqual(["error", "error", "error", "error"]);
      expect(
        ledger.issues
          .filter((issue) => issue.code === "unresolved_revision_reference")
          .flatMap((issue) => issue.sources),
      ).toHaveLength(4);
    }));

  it("holds competing corrections to one predecessor instead of choosing source order", async () =>
    withStore(async (store) => {
      const importId = await commitRows(store, "branch.csv", [
        row("SIM-A", "1", "T1"),
        row("SIM-A", "2", "T2", { OrigTradeID: "T1" }),
        row("SIM-A", "3", "T3", { OrigTradeID: "T1" }),
      ]);

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(0);
      const issue = ledger.issues.find(
        (candidate) => candidate.code === "ambiguous_revision_reference",
      );
      expect(issue?.severity).toBe("error");
      expect(issue?.sources).toEqual([
        { importId, rowNumber: 2 },
        { importId, rowNumber: 3 },
        { importId, rowNumber: 4 },
      ]);
    }));

  it("detects sibling corrections that become ready after their shared predecessor", async () =>
    withStore(async (store) => {
      const importId = await commitRows(store, "late-branch.csv", [
        row("SIM-A", "1", "T1"),
        row("SIM-A", "2", "T2", { OrigTradeID: "T1" }),
        row("SIM-A", "3", "T3", { OrigTradeID: "T2" }),
        row("SIM-A", "4", "T4", { OrigTradeID: "T2" }),
      ]);

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(0);
      const issue = ledger.issues.find(
        (candidate) => candidate.code === "ambiguous_revision_reference",
      );
      expect(issue?.severity).toBe("error");
      expect(issue?.sources).toEqual([
        { importId, rowNumber: 2 },
        { importId, rowNumber: 3 },
        { importId, rowNumber: 4 },
        { importId, rowNumber: 5 },
      ]);
    }));

  it("uses explicit revision lineage to resolve a reused execution ID", async () =>
    withStore(async (store) => {
      await commitRows(store, "reused-alias.csv", [
        row("SIM-A", "1", "T1", { IBExecID: "E1" }),
        row("SIM-A", "2", "T2", {
          IBExecID: "E1",
          OrigTradeID: "T1",
        }),
      ]);

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(1);
      expect(ledger.executions[0]?.key).toBe("txn:SIM-A:trade:T1");
      expect(ledger.executions[0]?.quantity).toBe("2");
      expect(ledger.issues).toHaveLength(0);
    }));

  it("propagates included quarantine diagnostics with durable source references", async () =>
    withStore(async (store) => {
      const validImport = await commitRows(store, "valid.csv", [
        row("SIM-A", "1", "T1", {
          TradeDate: "2026-10-01",
          DateTime: "2026-10-01 10:00:00",
        }),
        row("SIM-A", "-1", "T2", {
          TradeDate: "2026-10-02",
          DateTime: "2026-10-02 10:00:00",
          "Notes/Codes": "C",
          NetCash: "10",
        }),
      ]);
      const quarantineImport = await commitRows(store, "quarantine.csv", [
        row("SIM-A", "10", "Q1", { LevelOfDetail: "BOGUS" }),
      ]);

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const projection = await computeProjection(store, ledger, 0);

      const retainedRow = store.db
        .prepare(
          "SELECT row_number, row_kind, parse_errors_json FROM import_rows WHERE import_id = ?",
        )
        .get(quarantineImport) as {
        row_number: number;
        row_kind: string;
        parse_errors_json: string;
      };
      expect(retainedRow.row_kind).toBe("quarantine");
      expect(JSON.parse(retainedRow.parse_errors_json)).toHaveLength(1);
      expect(ledger.executions).toHaveLength(2);
      expect(projection.strategies.length).toBeGreaterThan(0);
      expect(
        projection.strategies.every(
          (strategy) => strategy.reconstructedPnl === null,
        ),
      ).toBe(true);
      const issue = ledger.issues.find(
        (candidate) => candidate.code === "unknown_level_of_detail",
      );
      expect(issue?.severity).toBe("error");
      expect(issue?.sources).toEqual([
        { importId: quarantineImport, rowNumber: retainedRow.row_number },
      ]);
      expect(issue?.sources[0]?.importId).not.toBe(validImport);
    }));

  it("fails closed when an execution alias names conflicting trades", async () =>
    withStore(async (store) => {
      const importId = await commitRows(store, "aliases.csv", [
        row("SIM-A", "1", "T1", { IBExecID: "E1" }),
        row("SIM-A", "1", "T2", { IBExecID: "E1" }),
        row("SIM-A", "1", "", { IBExecID: "E1" }),
      ]);

      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });

      expect(ledger.executions).toHaveLength(0);
      const issue = ledger.issues.find(
        (candidate) => candidate.code === "alias_conflict",
      );
      expect(issue?.severity).toBe("error");
      expect(issue?.sources).toEqual([
        { importId, rowNumber: 2 },
        { importId, rowNumber: 3 },
        { importId, rowNumber: 4 },
      ]);
      const retained = store.db
        .prepare(
          "SELECT count(*) AS count FROM import_rows WHERE import_id = ?",
        )
        .get(importId) as { count: number };
      expect(retained.count).toBe(3);
    }));
});

import { describe, expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeLedgerSnapshot,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { parseFlex } from "../../src/server/imports/csv.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { recordDecision } from "../../src/server/storage/decisions.js";
import {
  bothSettlements,
  cashRow,
  fundsCsv,
  settlementTrades,
} from "../fixtures/settlements.js";
import { createTestStore } from "../helpers/store.js";

async function setup(csv: string) {
  const t = await createTestStore();
  const upload = async (text: string) => {
    const preview = await previewImport(t.store, {
      bytes: new TextEncoder().encode(text),
      filename: "synthetic.csv",
      timezone: null,
    });
    const committed = await commitImport(t.store, preview.id);
    return { preview, ...committed };
  };
  const build = async (mode: "full" | "projection" = "full") => {
    await rebuild(t.store, {
      mode,
      parserVersion: "flex-v1",
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    const ledger = activeLedgerSnapshot(t.store);
    const projection = activeProjection(t.store).projection;
    if (!ledger || !projection?.lifecycles) throw Error("Missing build");
    return { ledger, projection, cycles: projection.lifecycles.lifecycles };
  };
  try {
    const uploaded = await upload(csv);
    return { ...t, upload, build, ...uploaded };
  } catch (error) {
    await t.dispose();
    throw error;
  }
}

describe("optional Statement of Funds settlement evidence", () => {
  it.each([true, false])(
    "recognizes cash rows without creating duplicate trades (funds first: %s)",
    async (first) => {
      const funds = fundsCsv([
        ...bothSettlements(),
        cashRow({
          ActivityCode: "BUY",
          TradeID: "long-open",
          ActivityDescription: "Buy SYN call",
          Debit: "-20",
        }),
        cashRow({
          ActivityDescription: "Unrelated commission adjustment",
          Debit: "-2",
        }),
      ]);
      const text = first
        ? `${funds}\n${settlementTrades()}`
        : `${settlementTrades()}\n${funds}`;
      const parsed = parseFlex(new TextEncoder().encode(text));
      expect(parsed.rows.filter((r) => r.kind === "cash")).toHaveLength(4);
      expect(parsed.issues).toEqual([]);
      const t = await setup(text);
      try {
        expect(t.preview.counts).toMatchObject({
          executions: 4,
          cashTransactions: 4,
          quarantined: 0,
        });
        const { ledger, cycles } = await t.build();
        expect(ledger.executions).toHaveLength(4);
        expect(ledger.issues).toEqual([]);
        expect(cycles.map((c) => c.reconstructedPnl).sort()).toEqual([
          "-200",
          "80",
        ]);
        expect(cycles.map((c) => c.brokerPnl).sort()).toEqual(["-200", "80"]);
        const event = ledger.executions.find(
          (e) => e.brokerIds.TradeID === "short-close",
        );
        expect(event).toMatchObject({
          event: "cash_settlement",
          netCash: "-300",
          quantity: "1",
          brokerPnl: "-200",
        });
        expect(event?.sources).toHaveLength(2);
        expect(
          (await t.build("projection")).cycles
            .map((c) => c.reconstructedPnl)
            .sort(),
        ).toEqual(["-200", "80"]);
      } finally {
        await t.dispose();
      }
    },
  );

  it("preserves trade-only behavior and can add or exclude a companion import", async () => {
    const t = await setup(settlementTrades());
    try {
      expect(
        (await t.build()).cycles.every((c) => c.reconstructedPnl === null),
      ).toBe(true);
      const added = await t.upload(fundsCsv(bothSettlements()));
      expect(
        (await t.build()).cycles.map((c) => c.reconstructedPnl).sort(),
      ).toEqual(["-200", "80"]);
      expect((await t.upload(fundsCsv(bothSettlements()))).duplicate).toBe(
        true,
      );
      expect((await t.build()).ledger.executions).toHaveLength(4);
      await recordDecision(t.store, {
        kind: "import_exclusion",
        author: "user",
        payload: { importId: added.importId },
      });
      expect(
        (await t.build()).cycles.every((c) => c.reconstructedPnl === null),
      ).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it.each([
    { name: "missing currency", patch: { CurrencyPrimary: "" } },
    { name: "wrong currency", patch: { CurrencyPrimary: "EUR" } },
    { name: "wrong account", patch: { ClientAccountID: "OTHER" } },
    {
      name: "conflicting trade references",
      patch: { RelatedTradeID: "short-close", TradeID: "OTHER-TRADE" },
    },
    { name: "wrong event date", patch: { Date: "20261015" } },
    {
      name: "wrong contract",
      patch: {
        ActivityDescription:
          "Option Cash Settlement for: Assignment ( SYN 16OCT26 110 C )",
      },
    },
    { name: "wrong cash sign", patch: { Debit: "", Credit: "300" } },
    { name: "invalid amount", patch: { Debit: "NaN" } },
    { name: "conflicting amount", patch: { Amount: "-301" } },
    { name: "conflicting contract id", patch: { Conid: "other" } },
    { name: "conflicting symbol", patch: { Symbol: "OTHER OPTION" } },
    { name: "wrong quantity", patch: { TradeQuantity: "2" } },
    { name: "invalid settlement date", patch: { SettleDate: "20260230" } },
    { name: "settlement before the event", patch: { SettleDate: "20261015" } },
  ])("keeps reconstruction unavailable for $name", async ({ patch }) => {
    const t = await setup(
      `${fundsCsv([cashRow(patch)], [...new Set([...Object.keys(cashRow()), ...Object.keys(patch)])])}\n${settlementTrades()}`,
    );
    try {
      const { cycles, ledger } = await t.build();
      expect(cycles.every((c) => c.reconstructedPnl === null)).toBe(true);
      expect(
        ledger.executions.find((e) => e.brokerIds.TradeID === "short-close")
          ?.netCash,
      ).toBe("0");
      expect(
        ledger.issues.some(
          (i) =>
            i.code.startsWith("cash_settlement_") && i.severity === "warning",
        ),
      ).toBe(true);
      expect(ledger.issues.some((i) => i.severity === "error")).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it.each(["duplicate", "different amount", "different transaction ids"])(
    "does not spend ambiguous cash evidence: %s",
    async (variant) => {
      const second =
        variant === "different amount"
          ? cashRow({ Debit: "-301" })
          : cashRow({
              ...(variant === "different transaction ids"
                ? { TransactionID: "two" }
                : {}),
            });
      const t = await setup(
        `${fundsCsv([cashRow({ ...(variant === "different transaction ids" ? { TransactionID: "one" } : {}) }), second])}\n${settlementTrades()}`,
      );
      try {
        expect(
          (await t.build()).cycles.every((c) => c.reconstructedPnl === null),
        ).toBe(true);
      } finally {
        await t.dispose();
      }
    },
  );

  it("deduplicates corroborating exports of the same settlement and retains both sources", async () => {
    const t = await setup(
      `${fundsCsv([cashRow({ TransactionID: "payment" })])}\n${settlementTrades()}`,
    );
    try {
      await t.upload(fundsCsv([cashRow({ TransactionID: "payment" })]));
      const { ledger } = await t.build();
      const event = ledger.executions.find(
        (e) => e.brokerIds.TradeID === "short-close",
      );
      expect(event?.netCash).toBe("-300");
      expect(event?.sources).toHaveLength(3);
    } finally {
      await t.dispose();
    }
  });

  it("reclassifies previously stored funds rows during a full rebuild", async () => {
    const t = await setup(
      `${fundsCsv(bothSettlements())}\n${settlementTrades()}`,
    );
    try {
      t.store.db
        .prepare(
          "UPDATE import_rows SET row_kind='execution' WHERE import_id=? AND row_number<4",
        )
        .run(t.importId);
      const { ledger, cycles } = await t.build();
      expect(ledger.issues).toEqual([]);
      expect(cycles.map((c) => c.reconstructedPnl).sort()).toEqual([
        "-200",
        "80",
      ]);
    } finally {
      await t.dispose();
    }
  });

  it("recognizes legacy funds header aliases during a full rebuild", async () => {
    const t = await setup(
      `${fundsCsv(bothSettlements())}\n${settlementTrades()}`,
    );
    try {
      const aliases: Record<string, string> = {
        ClientAccountID: "Account ID",
        ActivityCode: "Activity Code",
        ActivityDescription: "Activity Description",
        SettleDate: "Settle Date",
        TransactionID: "Transaction ID",
      };
      const rows = t.store.db
        .prepare(
          "SELECT id, raw_fields_json FROM import_rows WHERE import_id=? AND row_number<4",
        )
        .all(t.importId) as { id: string; raw_fields_json: string }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const fields = JSON.parse(row.raw_fields_json) as Record<
          string,
          string
        >;
        const legacy = Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            aliases[key] ?? key,
            value,
          ]),
        );
        t.store.db
          .prepare(
            "UPDATE import_rows SET row_kind='quarantine', raw_fields_json=? WHERE id=?",
          )
          .run(JSON.stringify(legacy), row.id);
      }
      const { ledger, cycles } = await t.build();
      expect(ledger.issues).toEqual([]);
      expect(ledger.executions).toHaveLength(4);
      expect(cycles.map((c) => c.reconstructedPnl).sort()).toEqual([
        "-200",
        "80",
      ]);
    } finally {
      await t.dispose();
    }
  });

  it("corroborates cash already present on an explicit cash-settlement close without adding it twice", async () => {
    // Build the replacement by column names rather than depending on CSV offsets.
    const { parse } = await import("csv-parse/sync");
    const rows = parse(settlementTrades()) as string[][];
    const header = rows[0];
    if (!header) throw Error("Missing synthetic header");
    for (const row of rows.slice(1))
      if (row[header.indexOf("TradeID")] === "short-close") {
        row[header.indexOf("NetCash")] = "-300";
        row[header.indexOf("Notes/Codes")] = "C;Off";
      }
    const t = await setup(
      `${fundsCsv([cashRow()])}\n${rows.map((r) => r.join(",")).join("\n")}`,
    );
    try {
      const result = await t.build();
      expect(result.ledger.issues).toEqual([]);
      expect(
        result.ledger.executions.find(
          (e) => e.brokerIds.TradeID === "short-close",
        )?.netCash,
      ).toBe("-300");
    } finally {
      await t.dispose();
    }
  });

  it("does not ignore contradictory symbol evidence in a corroborating export", async () => {
    const t = await setup(
      `${fundsCsv([cashRow({ TransactionID: "same" })])}\n${settlementTrades()}`,
    );
    try {
      await t.upload(
        fundsCsv(
          [cashRow({ TransactionID: "same", Symbol: "OTHER" })],
          [...Object.keys(cashRow()), "TransactionID", "Symbol"],
        ),
      );
      const result = await t.build();
      expect(result.cycles.every((c) => c.reconstructedPnl === null)).toBe(
        true,
      );
    } finally {
      await t.dispose();
    }
  });

  it("does not assume two cash rows without transaction IDs from different reports are the same payment", async () => {
    const t = await setup(`${fundsCsv([cashRow()])}\n${settlementTrades()}`);
    try {
      await t.upload(fundsCsv([cashRow()]));
      expect(
        (await t.build()).cycles.every((c) => c.reconstructedPnl === null),
      ).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("does not reuse a transaction ID for two different contracts", async () => {
    const rows = bothSettlements().map((r) => ({
      ...r,
      TransactionID: "same-payment",
    }));
    const t = await setup(`${fundsCsv(rows)}\n${settlementTrades()}`);
    try {
      expect(
        (await t.build()).cycles.every((c) => c.reconstructedPnl === null),
      ).toBe(true);
    } finally {
      await t.dispose();
    }
  });
});

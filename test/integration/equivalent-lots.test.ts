import { describe, expect, it } from "vitest";
import { strategyAnchorKey } from "../../src/server/decisions/registry.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type { Decision, LedgerSnapshot } from "../../src/shared/domain.js";
import {
  buildExecutionTable,
  type ExecutionFields,
  executionRow,
} from "../fixtures/scenarios.js";
import { seedLedger } from "../helpers/chat.js";
import { createTestStore } from "../helpers/store.js";

function row(id: string, closing = false, patch: ExecutionFields = {}) {
  return executionRow({
    ClientAccountID: "SIM-LOTS",
    AssetClass: "STK",
    Symbol: "TEST",
    Conid: "TEST",
    CurrencyPrimary: "USD",
    Multiplier: "1",
    TradeDate: closing ? "2025-04-15" : "2025-04-01",
    DateTime: closing ? "2025-04-15 10:00:00" : "2025-04-01 10:00:00",
    Quantity: closing ? "-2" : "2",
    TradePrice: closing ? "60" : "50",
    NetCash: closing ? "119" : "-101",
    CostBasis: closing ? "-101" : "101",
    FifoPnlRealized: closing ? "18" : "0",
    "Notes/Codes": closing ? "C" : "O",
    IBExecID: id,
    TradeID: id,
    IBOrderID: id,
    BrokerageOrderID: id,
    ...patch,
  });
}

async function withLedger(
  rows: ExecutionFields[],
  run: (ledger: LedgerSnapshot) => void,
) {
  const fixture = await createTestStore();
  try {
    const { ledger } = await seedLedger(
      fixture.store,
      buildExecutionTable(rows),
    );
    run(ledger);
  } finally {
    await fixture.dispose();
  }
}

function resolveId(account: string, keys: string[]) {
  return strategyAnchorKey({ account, openingKeys: keys });
}

function strategyFor(ledger: LedgerSnapshot, tradeId: string) {
  const execution = ledger.executions.find(
    (e) => e.brokerIds.TradeID === tradeId,
  );
  if (!execution) throw new Error(`Missing execution ${tradeId}`);
  return resolveId(execution.account, [execution.key]);
}

describe("equivalent opening lots", () => {
  it("matches simultaneous identical lots by execution key, independent of input order or strategy IDs", async () => {
    await withLedger(
      [
        row("OPEN-A"),
        row("OPEN-B", false, {
          Quantity: "2.0",
          TradePrice: "50.00",
          NetCash: "-101.00",
        }),
        row("CLOSE-A", true, {
          TradeDate: "2025-04-01",
          DateTime: "2025-04-01 11:00:00",
          TradePrice: "55",
          NetCash: "109",
          FifoPnlRealized: "8",
        }),
        row("CLOSE-B", true),
      ],
      (ledger) => {
        for (const executions of [
          ledger.executions,
          [...ledger.executions].reverse(),
        ]) {
          const projection = groupStrategies(
            { ...ledger, executions },
            [],
            resolveId,
          );
          expect(projection.issues).toEqual([]);
          expect(projection.strategies).toHaveLength(2);
          expect(projection.strategies.map((s) => s.status)).toEqual([
            "closed",
            "closed",
          ]);
          for (const suffix of ["A", "B"]) {
            const close = executions.find(
              (e) => e.brokerIds.TradeID === `CLOSE-${suffix}`,
            );
            expect(
              projection.allocations.find((a) => a.executionKey === close?.key)
                ?.strategyId,
            ).toBe(strategyFor(ledger, `OPEN-${suffix}`));
          }
          // Deliberately reverse the ordering of strategy IDs: it must not decide lot attribution.
          const remapped = groupStrategies(
            { ...ledger, executions },
            [],
            (account, keys) =>
              resolveId(account, keys) === strategyFor(ledger, "OPEN-A")
                ? "z-first-lot"
                : "a-second-lot",
          );
          const firstClose = executions.find(
            (e) => e.brokerIds.TradeID === "CLOSE-A",
          );
          expect(
            remapped.allocations.find((a) => a.executionKey === firstClose?.key)
              ?.strategyId,
          ).toBe("z-first-lot");
        }
      },
    );
  });

  it.each([
    { name: "different net cash", patch: { NetCash: "-102" } },
    { name: "different cost basis", patch: { CostBasis: "102" } },
    { name: "different price", patch: { TradePrice: "50.5" } },
    { name: "different quantity", patch: { Quantity: "4" } },
    {
      name: "different opening time",
      patch: { DateTime: "2025-04-01 10:00:01" },
    },
    { name: "different multiplier", patch: { Multiplier: "2" } },
    { name: "different fees", patch: { IBCommission: "-2" } },
    { name: "missing price", patch: { TradePrice: "" } },
    {
      name: "an explicit broker reference",
      patch: { RelatedTradeID: "specific-opening" },
    },
  ])("keeps $name ambiguous", async ({ patch }) => {
    await withLedger(
      [row("OPEN-A"), row("OPEN-B", false, patch), row("CLOSE-A", true)],
      (ledger) => {
        const projection = groupStrategies(ledger, [], resolveId);
        expect(projection.issues.map((i) => i.code)).toContain(
          "AMBIGUOUS_CLOSE",
        );
        expect(
          projection.strategies.filter((s) => s.status === "open"),
        ).toHaveLength(2);
      },
    );
  });

  it("does not choose an equivalent lot when the close reports a conflicting basis", async () => {
    await withLedger(
      [
        row("OPEN-A"),
        row("OPEN-B"),
        row("CLOSE-A", true, { CostBasis: "-999" }),
      ],
      (ledger) => {
        expect(
          groupStrategies(ledger, [], resolveId).issues.map((i) => i.code),
        ).toContain("AMBIGUOUS_CLOSE");
      },
    );
  });

  it("keeps conflicting known contract identities ambiguous even when a weak row matches both", async () => {
    await withLedger(
      [
        row("OPEN-A", false, { Conid: "" }),
        row("OPEN-B", false, { Conid: "111" }),
        row("OPEN-C", false, { Conid: "222" }),
        row("CLOSE-A", true, { Conid: "" }),
      ],
      (ledger) => {
        expect(
          groupStrategies(ledger, [], resolveId).issues.map((i) => i.code),
        ).toContain("AMBIGUOUS_CLOSE");
      },
    );
  });

  it("does not choose a lot in a multi-leg strategy", async () => {
    await withLedger(
      [
        row("OPEN-A"),
        row("OPEN-B"),
        row("OTHER-LEG", false, {
          Symbol: "OTHER",
          Conid: "OTHER",
          BrokerageOrderID: "OPEN-A",
          IBOrderID: "OPEN-A",
        }),
        row("CLOSE-A", true),
      ],
      (ledger) => {
        expect(
          groupStrategies(ledger, [], resolveId).issues.map((i) => i.code),
        ).toContain("AMBIGUOUS_CLOSE");
      },
    );
  });

  it("does not override conflicting broker lot evidence", async () => {
    await withLedger(
      [
        row("OPEN-A"),
        row("OPEN-B"),
        row("CLOSE-A", true),
        row("LOT", true, {
          LevelOfDetail: "CLOSED_LOT",
          TradeID: "CLOSE-A",
          OpenDateTime: "2025-03-31 10:00:00",
          IBExecID: "",
          IBOrderID: "",
          BrokerageOrderID: "",
        }),
      ],
      (ledger) => {
        expect(ledger.lots).toHaveLength(1);
        expect(
          groupStrategies(ledger, [], resolveId).issues.map((i) => i.code),
        ).toContain("AMBIGUOUS_CLOSE");
      },
    );
  });

  it("honours a retained close binding ahead of the equivalent-lot ordering", async () => {
    await withLedger(
      [row("OPEN-A"), row("OPEN-B"), row("CLOSE-A", true)],
      (ledger) => {
        const close = ledger.executions.find(
          (e) => e.brokerIds.TradeID === "CLOSE-A",
        );
        if (!close) throw new Error("Missing close");
        const decision: Decision = {
          id: "explicit-close",
          sequence: 1,
          kind: "group_explicit",
          sources: close.sources,
          strategyIds: [strategyFor(ledger, "OPEN-B")],
          supersedesId: null,
          payload: {
            strategyId: strategyFor(ledger, "OPEN-B"),
            source: close.sources[0],
          },
        };
        const projection = groupStrategies(ledger, [decision], resolveId);
        expect(projection.issues).toEqual([]);
        expect(
          projection.allocations.find((a) => a.executionKey === close.key)
            ?.strategyId,
        ).toBe(strategyFor(ledger, "OPEN-B"));
      },
    );
  });
});

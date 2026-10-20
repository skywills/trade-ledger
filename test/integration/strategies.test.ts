import { describe, expect, it } from "vitest";
import { strategyAnchorKey } from "../../src/server/decisions/registry.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { normalizeLedger } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type {
  Decision,
  Execution,
  LedgerSnapshot,
  Projection,
  SourceRef,
} from "../../src/shared/domain.js";
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
): Promise<void> {
  const preview = await previewImport(store, {
    filename,
    bytes,
    timezone: "UTC",
  });
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
}

async function ledgerFrom(
  store: Store,
  filename: string,
  bytes: Uint8Array,
): Promise<LedgerSnapshot> {
  await commitBytes(store, filename, bytes);
  return normalizeLedger(store, {
    parserVersion: "flex-v1",
    decisionWatermark: 0,
  });
}

/** Deterministic, synchronous, store-free strategy identity resolver. */
function resolveId(account: string, keys: string[]): string {
  return strategyAnchorKey({ account, openingKeys: keys });
}

function exec(ledger: LedgerSnapshot, tradeId: string): Execution {
  const found = ledger.executions.find((e) => e.brokerIds.TradeID === tradeId);
  if (found === undefined) throw new Error(`no execution for ${tradeId}`);
  return found;
}

function sourceOf(execution: Execution): SourceRef {
  const source = execution.sources[0];
  if (source === undefined) throw new Error("execution has no source");
  return source;
}

function decision(
  kind: string,
  payload: Record<string, unknown>,
  overrides: Partial<Decision> = {},
): Decision {
  return {
    id: overrides.id ?? `decision-${kind}`,
    sequence: overrides.sequence ?? 1,
    kind,
    sources: overrides.sources ?? [],
    strategyIds: overrides.strategyIds ?? [],
    payload,
    supersedesId: overrides.supersedesId ?? null,
  };
}

function canonical(projection: Projection): string {
  const strategies = [...projection.strategies]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((strategy) => ({
      ...strategy,
      positions: [...strategy.positions].sort((a, b) =>
        a.instrumentKey < b.instrumentKey ? -1 : 1,
      ),
      reasons: [...strategy.reasons].sort(),
    }));
  const allocations = [...projection.allocations].sort((a, b) =>
    `${a.strategyId}|${a.executionKey}` < `${b.strategyId}|${b.executionKey}`
      ? -1
      : 1,
  );
  const links = [...projection.links].sort((a, b) =>
    `${a.from}|${a.to}|${a.type}` < `${b.from}|${b.to}|${b.type}` ? -1 : 1,
  );
  const issues = [...projection.issues].sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );
  return JSON.stringify({ strategies, allocations, links, issues });
}

function optionLeg(
  order: string,
  tradeId: string,
  overrides: Partial<ExecutionFields> = {},
): ExecutionFields {
  return executionRow({
    ClientAccountID: "SIM-Z",
    AssetClass: "OPT",
    Symbol: "TEST",
    UnderlyingSymbol: "TEST",
    Conid:
      overrides.Conid ??
      `9${overrides.Strike ?? "100"}${overrides["Put/Call"] ?? "C"}${(
        overrides.Expiry ?? "2026-12-18"
      ).replaceAll("-", "")}`,
    CurrencyPrimary: "USD",
    TradeDate: overrides.TradeDate ?? "2026-09-03",
    DateTime: `${overrides.TradeDate ?? "2026-09-03"} 10:00:00`,
    Quantity: overrides.Quantity ?? "+1",
    TradePrice: overrides.TradePrice ?? "2",
    NetCash: overrides.NetCash ?? "-200",
    "Notes/Codes": overrides["Notes/Codes"] ?? "O",
    IBOrderID: order,
    BrokerageOrderID: order,
    IBExecID: `EXEC-${tradeId}`,
    TradeID: tradeId,
    Expiry: overrides.Expiry ?? "2026-12-18",
    Strike: overrides.Strike ?? "100",
    "Put/Call": overrides["Put/Call"] ?? "C",
    Multiplier: overrides.Multiplier ?? "100",
    ...overrides,
  });
}

describe("strategy grouping, closes and option lifecycle links", () => {
  it("groups scenario A into one bull put spread and fully closes its exposure", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(store, "spread.csv", fixtures.spread);
      const projection = groupStrategies(ledger, [], resolveId);

      const bull = projection.strategies.find(
        (s) => s.type === "bull_put_spread",
      );
      expect(bull).toBeDefined();
      expect(bull?.positions.every((p) => p.quantity === "0")).toBe(true);
      expect(bull?.status).toBe("closed");
      expect(bull?.closeDate).toBe("2026-09-25");
      expect(projection.strategies).toHaveLength(1);
      // Four executions, each allocated exactly once.
      expect(projection.allocations).toHaveLength(4);
      expect(
        new Set(projection.allocations.map((a) => a.executionKey)).size,
      ).toBe(4);
    }));

  it("groups one verified opening group across partial fills", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(
        store,
        "partial.csv",
        fixtures.partialFills,
      );
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      const strategy = projection.strategies[0];
      expect(projection.allocations).toHaveLength(2);
      expect(strategy?.positions).toHaveLength(1);
      expect(strategy?.positions[0]?.quantity).toBe("4");
      expect(strategy?.status).toBe("open");
      // Both fills belong to the same strategy id.
      const ids = new Set(projection.allocations.map((a) => a.strategyId));
      expect(ids.size).toBe(1);
    }));

  it("splits separate close and open roles within one order and links a roll", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(store, "roll.csv", fixtures.roll);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(projection.links.filter((l) => l.type === "roll")).toHaveLength(1);
    }));

  it("keeps same-symbol and expiry openings from distinct orders separate", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("ORDER-1", "T-1", { Quantity: "+1" }),
        optionLeg("ORDER-2", "T-2", { Quantity: "+1" }),
      ]);
      const ledger = await ledgerFrom(store, "distinct.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(projection.allocations).toHaveLength(2);
    }));

  it("resolves multi-open ambiguity deterministically rather than arbitrary FIFO", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN-1", "T-1", { TradeDate: "2026-09-01" }),
        optionLeg("OPEN-2", "T-2", { TradeDate: "2026-09-02" }),
        optionLeg("CLOSE-1", "T-3", {
          TradeDate: "2026-09-03",
          Quantity: "-1",
          "Notes/Codes": "C",
          NetCash: "300",
          TradePrice: "3",
        }),
      ]);
      const ledger = await ledgerFrom(store, "ambiguous.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.issues.map((i) => i.code)).toContain("AMBIGUOUS_CLOSE");
      // Neither opening is arbitrarily consumed; both remain intact.
      expect(projection.allocations).toHaveLength(3);
      expect(
        projection.strategies.filter((s) => s.status === "open"),
      ).toHaveLength(2);

      const reversed: LedgerSnapshot = {
        ...ledger,
        executions: [...ledger.executions].reverse(),
      };
      const reversedProjection = groupStrategies(reversed, [], resolveId);
      expect(canonical(reversedProjection)).toBe(canonical(projection));
    }));

  it("matches closes using known lot references", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN-1", "T-1", {
          TradeDate: "2026-09-01",
          Conid: "9001",
        }),
        optionLeg("OPEN-2", "T-2", {
          TradeDate: "2026-09-02",
          Conid: "9001",
        }),
        optionLeg("CLOSE-1", "T-CLOSE", {
          TradeDate: "2026-09-03",
          Quantity: "-1",
          "Notes/Codes": "C",
          NetCash: "300",
          TradePrice: "3",
          Conid: "9001",
        }),
        {
          ...optionLeg("LOT", "unused", {}),
          LevelOfDetail: "CLOSED_LOT",
          TradeID: "T-CLOSE",
          OpenDateTime: "2026-09-01 10:00:00",
          "Notes/Codes": "ST",
          Quantity: "-1",
          NetCash: "",
          TradePrice: "",
          IBExecID: "",
          IBOrderID: "",
          BrokerageOrderID: "",
        },
      ]);
      const ledger = await ledgerFrom(store, "lots.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      const opening1Key = exec(ledger, "T-1").key;
      const opening2Key = exec(ledger, "T-2").key;
      const strategyOf = (key: string) =>
        projection.allocations.find((a) => a.executionKey === key)?.strategyId;
      const firstId = strategyOf(opening1Key);
      const secondId = strategyOf(opening2Key);
      const first = projection.strategies.find((s) => s.id === firstId);
      const second = projection.strategies.find((s) => s.id === secondId);

      expect(first?.status).toBe("closed");
      expect(second?.status).toBe("open");
      expect(projection.issues.map((i) => i.code)).not.toContain(
        "AMBIGUOUS_CLOSE",
      );
    }));

  it("classifies common vertical spreads from signed leg direction", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("BULL-CALL", "T-BC-L", { Strike: "100", "Put/Call": "C" }),
        optionLeg("BULL-CALL", "T-BC-S", {
          Strike: "110",
          "Put/Call": "C",
          Quantity: "-1",
          NetCash: "200",
        }),
        optionLeg("BEAR-CALL", "T-BRC-S", {
          Strike: "100",
          "Put/Call": "C",
          Quantity: "-1",
          NetCash: "200",
        }),
        optionLeg("BEAR-CALL", "T-BRC-L", { Strike: "110", "Put/Call": "C" }),
        optionLeg("BULL-PUT", "T-BP-L", { Strike: "90", "Put/Call": "P" }),
        optionLeg("BULL-PUT", "T-BP-S", {
          Strike: "100",
          "Put/Call": "P",
          Quantity: "-1",
          NetCash: "200",
        }),
        optionLeg("BEAR-PUT", "T-BRP-S", {
          Strike: "90",
          "Put/Call": "P",
          Quantity: "-1",
          NetCash: "200",
        }),
        optionLeg("BEAR-PUT", "T-BRP-L", { Strike: "100", "Put/Call": "P" }),
      ]);
      const ledger = await ledgerFrom(store, "verticals.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      const types = projection.strategies.map((s) => s.type).sort();
      expect(types).toEqual([
        "bear_call_spread",
        "bear_put_spread",
        "bull_call_spread",
        "bull_put_spread",
      ]);
    }));

  it.each([
    [
      "short_call",
      [
        ["C", "100", "-1"],
        ["C", "100", "-2"],
      ],
    ],
    [
      "long_call",
      [
        ["C", "100", "1"],
        ["C", "100", "2"],
      ],
    ],
    ["short_put", [["P", "100", "-1"]]],
    ["long_put", [["P", "100", "1"]]],
    [
      "bull_call_spread",
      [
        ["C", "35", "1"],
        ["C", "35", "1"],
        ["C", "75", "-1"],
        ["C", "75", "-1"],
      ],
    ],
    [
      "iron_condor",
      [
        ["P", "7510", "1"],
        ["P", "7530", "-1"],
        ["C", "7730", "-1"],
        ["C", "7735", "1"],
      ],
    ],
    [
      "reverse_iron_condor",
      [
        ["P", "90", "-2"],
        ["P", "95", "2"],
        ["C", "105", "2"],
        ["C", "110", "-2"],
      ],
    ],
    [
      "iron_butterfly",
      [
        ["P", "90", "1"],
        ["P", "100", "-1"],
        ["C", "100", "-1"],
        ["C", "110", "1"],
      ],
    ],
    [
      "call_butterfly",
      [
        ["C", "90", "1"],
        ["C", "100", "-2"],
        ["C", "110", "1"],
      ],
    ],
    [
      "broken_wing_call_butterfly",
      [
        ["C", "145", "1"],
        ["C", "150", "-2"],
        ["C", "160", "1"],
      ],
    ],
    [
      "put_butterfly",
      [
        ["P", "90", "1"],
        ["P", "100", "-2"],
        ["P", "110", "1"],
      ],
    ],
    [
      "call_ratio_spread",
      [
        ["C", "90", "1"],
        ["C", "100", "-2"],
      ],
    ],
    [
      "custom",
      [
        ["C", "100", "1"],
        ["C", "100", "-1"],
      ],
    ],
    [
      "custom",
      [
        ["P", "90", "1"],
        ["P", "95", "-1"],
        ["C", "105", "-2"],
        ["C", "110", "1"],
      ],
    ],
  ] as const)("classifies %s from contract quantities", (expected, legs) =>
    withStore(async (store) => {
      const rows = buildExecutionTable(
        legs.map(([putCall, strike, quantity], index) =>
          optionLeg("COMBO", `T-${index}`, {
            "Put/Call": putCall,
            Strike: strike,
            Quantity: quantity,
          }),
        ),
      );
      const ledger = await ledgerFrom(store, "combo.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);
      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.type).toBe(expected);
      // Classification must not collapse the financial allocation rows.
      expect(projection.allocations).toHaveLength(legs.length);
    }),
  );

  it("projects the requested option description from imported broker rows", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("UNH-SPREAD", "UNH-SHORT", {
          Symbol: "UNH",
          UnderlyingSymbol: "UNH",
          Strike: "390",
          Expiry: "2026-09-18",
          "Put/Call": "P",
          Quantity: "-1",
        }),
        optionLeg("UNH-SPREAD", "UNH-LONG", {
          Symbol: "UNH",
          UnderlyingSymbol: "UNH",
          Strike: "380",
          Expiry: "2026-09-18",
          "Put/Call": "P",
          Quantity: "1",
        }),
      ]);
      const ledger = await ledgerFrom(store, "unh.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);
      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.description).toBe(
        "UNH Sep18'26 380/390 Bull Put Spread",
      );
    }));

  it("labels mixed-expiry groups as Mixed with no expiry year", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("MIXED", "T-M-1", { Expiry: "2026-12-18" }),
        optionLeg("MIXED", "T-M-2", {
          Expiry: "2027-01-15",
          Strike: "110",
          Quantity: "-1",
          NetCash: "150",
        }),
      ]);
      const ledger = await ledgerFrom(store, "mixed.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.type).toBe("custom");
      expect(projection.strategies[0]?.expiry).toBe("Mixed");
      expect(projection.strategies[0]?.expiryYear).toBeNull();
    }));

  it("keeps the real expiry and year for a single-expiry group", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("SINGLE", "T-S-1", { Expiry: "2027-01-15" }),
      ]);
      const ledger = await ledgerFrom(store, "single.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.expiry).toBe("2027-01-15");
      expect(projection.strategies[0]?.expiryYear).toBe(2027);
    }));

  it("tracks partial closure without inventing a close date", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN", "T-O", {
          Quantity: "+2",
          NetCash: "-400",
          TradePrice: "2",
        }),
        optionLeg("CLOSE", "T-C", {
          TradeDate: "2026-09-25",
          Quantity: "-1",
          "Notes/Codes": "C",
          NetCash: "300",
          TradePrice: "3",
        }),
      ]);
      const ledger = await ledgerFrom(store, "partial-close.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      const strategy = projection.strategies[0];
      expect(strategy?.status).toBe("partially_closed");
      expect(strategy?.positions[0]?.quantity).toBe("1");
      expect(strategy?.closeDate).toBeNull();
    }));

  it("classifies shares with no expiry year", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        executionRow({
          ClientAccountID: "SIM-Z",
          AssetClass: "STK",
          Symbol: "ACME",
          UnderlyingSymbol: "ACME",
          Conid: "7001",
          CurrencyPrimary: "USD",
          TradeDate: "2026-09-03",
          DateTime: "2026-09-03 10:00:00",
          Quantity: "+100",
          TradePrice: "10",
          NetCash: "-1000",
          "Notes/Codes": "O",
          IBOrderID: "STOCK-OPEN",
          BrokerageOrderID: "STOCK-OPEN",
          IBExecID: "EXEC-STOCK",
          TradeID: "T-STOCK",
          Multiplier: "1",
        }),
      ]);
      const ledger = await ledgerFrom(store, "stock.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.type).toBe("stock");
      expect(projection.strategies[0]?.expiry).toBeNull();
      expect(projection.strategies[0]?.expiryYear).toBeNull();
    }));

  it("closes an option on expiration without assuming a price source", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN", "T-O", { Quantity: "+1", NetCash: "-500" }),
        optionLeg("EXP", "T-X", {
          TradeDate: "2026-12-18",
          Quantity: "-1",
          "Notes/Codes": "Exp",
          NetCash: "0",
          TradePrice: "",
        }),
      ]);
      const ledger = await ledgerFrom(store, "expiry.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      const strategy = projection.strategies[0];
      expect(strategy?.status).toBe("closed");
      expect(strategy?.positions.every((p) => p.quantity === "0")).toBe(true);
    }));

  it("closes an option through explicit cash settlement", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN", "T-O", { Quantity: "-1", NetCash: "500" }),
        optionLeg("CASH", "T-CASH", {
          TradeDate: "2026-12-18",
          Quantity: "+1",
          "Notes/Codes": "Off",
          NetCash: "100",
          TradePrice: "1",
        }),
      ]);
      const ledger = await ledgerFrom(store, "cash.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]?.status).toBe("closed");
    }));

  it("warns when a derivative leg has no multiplier", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN", "T-O", { Multiplier: "" }),
      ]);
      const ledger = await ledgerFrom(store, "no-mult.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.issues.map((i) => i.code)).toContain(
        "MISSING_MULTIPLIER",
      );
      expect(projection.strategies[0]?.complete).toBe(false);
    }));

  it("blocks definitive closure when unsupported inventory is present", () => {
    const contract = {
      key: "conid:5555",
      assetClass: "OPT",
      symbol: "ACME",
      underlying: "ACME",
      conid: "5555",
      expiry: "2026-12-18",
      strike: "100",
      putCall: "C" as const,
      multiplier: "100",
    };
    const base = {
      account: "SIM-Z",
      instrument: contract,
      date: "2026-09-03",
      rawDateTime: "2026-09-03T10:00:00",
      timezone: null,
      price: "5",
      currency: "USD",
      proceeds: null,
      commission: null,
      taxes: null,
      basis: null,
      brokerPnl: null,
      codes: ["O"],
      sources: [{ importId: "imp", rowNumber: 1 }],
    };
    const ledger: LedgerSnapshot = {
      id: "ledger-synthetic",
      inputHash: "hash",
      executions: [
        {
          ...base,
          key: "txn:SIM-Z:trade:OPEN",
          quantity: "+1",
          netCash: "-500",
          action: "open",
          event: "trade",
          brokerIds: { TradeID: "OPEN" },
        },
        {
          ...base,
          key: "txn:SIM-Z:trade:CORP",
          quantity: "+1",
          netCash: "0",
          price: null,
          action: "unknown",
          event: "unsupported",
          brokerIds: { TradeID: "CORP" },
          codes: [],
          sources: [{ importId: "imp", rowNumber: 2 }],
        },
        {
          ...base,
          key: "txn:SIM-Z:trade:CLOSE",
          quantity: "-1",
          netCash: "600",
          action: "close",
          event: "trade",
          brokerIds: { TradeID: "CLOSE" },
          codes: ["C"],
          sources: [{ importId: "imp", rowNumber: 3 }],
        },
      ],
      lots: [],
      issues: [],
      conflicts: 0,
    };

    const projection = groupStrategies(ledger, [], resolveId);
    expect(projection.issues.map((i) => i.code)).toContain(
      "UNSUPPORTED_INVENTORY",
    );
    const strategy = projection.strategies.find((s) =>
      s.positions.some((p) => p.instrumentKey === "conid:5555"),
    );
    expect(strategy?.status).toBe("unresolved");
    expect(strategy?.complete).toBe(false);
  });

  it("links assignment and exercise lifecycle events by PositionActionID", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(
        store,
        "assignment.csv",
        fixtures.assignment,
      );
      const projection = groupStrategies(ledger, [], resolveId);

      expect(
        projection.links.filter(
          (l) => l.type === "assignment" || l.type === "exercise",
        ),
      ).toHaveLength(2);
    }));

  it("emits LIFECYCLE_UNRESOLVED when lifecycle evidence is missing", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(store, "reduced.csv", fixtures.reduced);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.issues.map((i) => i.code)).toContain(
        "LIFECYCLE_UNRESOLVED",
      );
    }));

  it("surfaces a retained group_split as not applied instead of a silent no-op", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(store, "spread.csv", fixtures.spread);
      const decisions: Decision[] = [
        decision("group_split", {
          parentStrategyId: "strategy-parent",
          childStrategyIds: ["strategy-child-a", "strategy-child-b"],
          notesOwnerStrategyId: "strategy-child-a",
        }),
      ];
      const projection = groupStrategies(ledger, decisions, resolveId);

      const split = projection.issues.find(
        (issue) => issue.code === "SPLIT_NOT_APPLIED",
      );
      expect(split?.severity).toBe("warning");
      expect(split?.key).toContain("strategy-parent");
    }));

  it("applies manual allocations before automatic matching of the remainder", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(store, "spread.csv", fixtures.spread);
      const manual = exec(ledger, "TRADE-A-1");
      const decisions: Decision[] = [
        decision(
          "manual_allocation",
          {
            strategyId: "manual-strategy",
            source: sourceOf(manual),
            allocations: [
              {
                executionKey: manual.key,
                quantity: manual.quantity,
                netCash: manual.netCash,
                brokerPnl: null,
              },
            ],
          },
          { strategyIds: ["manual-strategy"] },
        ),
      ];
      const projection = groupStrategies(ledger, decisions, resolveId);

      const manualAllocation = projection.allocations.find(
        (a) => a.executionKey === manual.key,
      );
      expect(manualAllocation?.strategyId).toBe("manual-strategy");
      // The execution is allocated exactly once, not duplicated by auto grouping.
      expect(
        projection.allocations.filter((a) => a.executionKey === manual.key),
      ).toHaveLength(1);
    }));

  it("emits a manual allocation row's own partial quantity and auto-matches only the residual", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN", "T-O", { Quantity: "+2", NetCash: "-400" }),
      ]);
      const ledger = await ledgerFrom(store, "manual-partial.csv", rows);
      const open = exec(ledger, "T-O");
      const decisions: Decision[] = [
        decision(
          "manual_allocation",
          {
            strategyId: "manual-strat",
            source: sourceOf(open),
            allocations: [
              {
                executionKey: open.key,
                quantity: "1",
                netCash: "-100",
                brokerPnl: null,
              },
            ],
          },
          { id: "m1", sequence: 1, strategyIds: ["manual-strat"] },
        ),
      ];

      const projection = groupStrategies(ledger, decisions, resolveId);

      const manualAllocation = projection.allocations.find(
        (a) => a.strategyId === "manual-strat",
      );
      // (a) the emitted allocation equals the decision row, not the full +2.
      expect(manualAllocation?.quantity).toBe("1");
      expect(manualAllocation?.netCash).toBe("-100");
      // (b) the residual +1 is the only thing auto-matched by later grouping.
      const residual = projection.allocations.filter(
        (a) => a.executionKey === open.key && a.strategyId !== "manual-strat",
      );
      expect(residual).toHaveLength(1);
      expect(residual[0]?.quantity).toBe("1");
      expect(projection.strategies).toHaveLength(2);
    }));

  it("partitions one execution across two strategies", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN", "T-O", { Quantity: "+2", NetCash: "-400" }),
      ]);
      const ledger = await ledgerFrom(store, "manual-split.csv", rows);
      const open = exec(ledger, "T-O");
      const decisions: Decision[] = [
        decision(
          "manual_allocation",
          {
            strategyId: "strat-a",
            source: sourceOf(open),
            allocations: [
              {
                executionKey: open.key,
                quantity: "1",
                netCash: "-200",
                brokerPnl: null,
              },
            ],
          },
          { id: "m1", sequence: 1, strategyIds: ["strat-a"] },
        ),
        decision(
          "manual_allocation",
          {
            strategyId: "strat-b",
            source: sourceOf(open),
            allocations: [
              {
                executionKey: open.key,
                quantity: "1",
                netCash: "-200",
                brokerPnl: null,
              },
            ],
          },
          { id: "m2", sequence: 2, strategyIds: ["strat-b"] },
        ),
      ];

      const projection = groupStrategies(ledger, decisions, resolveId);

      const allocationFor = (strategyId: string) =>
        projection.allocations.find((a) => a.strategyId === strategyId);
      expect(allocationFor("strat-a")?.quantity).toBe("1");
      expect(allocationFor("strat-b")?.quantity).toBe("1");
      // Fully partitioned manually: no residual auto-group remains.
      expect(projection.allocations).toHaveLength(2);
      expect(projection.strategies).toHaveLength(2);
    }));

  it("records a roll link without merging allocations", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPEN-1", "T-1", {
          Strike: "100",
          "Put/Call": "P",
          Quantity: "-1",
          NetCash: "200",
        }),
        optionLeg("ROLL", "T-CLOSE", {
          TradeDate: "2026-09-25",
          Strike: "100",
          "Put/Call": "P",
          Quantity: "+1",
          "Notes/Codes": "C",
          NetCash: "-150",
        }),
        optionLeg("ROLL", "T-OPEN", {
          TradeDate: "2026-09-25",
          Strike: "95",
          "Put/Call": "P",
          Quantity: "-1",
          Expiry: "2026-11-20",
          NetCash: "180",
        }),
      ]);
      const ledger = await ledgerFrom(store, "roll-link.csv", rows);
      const projection = groupStrategies(ledger, [], resolveId);

      expect(projection.strategies).toHaveLength(2);
      expect(projection.links.filter((l) => l.type === "roll")).toHaveLength(1);
    }));

  it("supports group_merge consolidation without duplicating allocations", () =>
    withStore(async (store) => {
      const ledger = await ledgerFrom(
        store,
        "assignment.csv",
        fixtures.assignment,
      );
      const baseline = groupStrategies(ledger, [], resolveId);

      const optionKey = exec(ledger, "TRADE-B-1").key;
      const stockKey = exec(ledger, "TRADE-B-2").key;
      const strategyFor = (executionKey: string) =>
        baseline.allocations.find((a) => a.executionKey === executionKey)
          ?.strategyId;
      const chosenStrategyId = strategyFor(optionKey);
      const mergedStrategyId = strategyFor(stockKey);
      if (chosenStrategyId === undefined || mergedStrategyId === undefined) {
        throw new Error("missing strategies for consolidation");
      }

      const mergeDecision = decision(
        "group_merge",
        {
          chosenStrategyId,
          mergedStrategyIds: [mergedStrategyId],
        },
        { strategyIds: [chosenStrategyId, mergedStrategyId] },
      );
      const consolidated = groupStrategies(ledger, [mergeDecision], resolveId);

      expect(consolidated.strategies).toHaveLength(
        baseline.strategies.length - 1,
      );
      expect(consolidated.allocations).toHaveLength(
        baseline.allocations.length,
      );
      expect(
        new Set(consolidated.allocations.map((a) => a.executionKey)).size,
      ).toBe(consolidated.allocations.length);
      const merged = consolidated.strategies.find(
        (s) => s.id === chosenStrategyId,
      );
      expect(merged).toBeDefined();
      const mergedKeys = new Set(
        consolidated.allocations
          .filter((a) => a.strategyId === chosenStrategyId)
          .map((a) => a.executionKey),
      );
      expect(mergedKeys.has(optionKey)).toBe(true);
      expect(mergedKeys.has(stockKey)).toBe(true);
    }));

  it("applies a lifecycle decision and rejects an inconsistent one", () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        optionLeg("OPT", "T-OPT", {
          Strike: "100",
          "Put/Call": "P",
          Quantity: "-1",
          NetCash: "200",
        }),
        executionRow({
          ClientAccountID: "SIM-Z",
          AssetClass: "STK",
          Symbol: "TEST",
          UnderlyingSymbol: "TEST",
          Conid: "7002",
          CurrencyPrimary: "USD",
          TradeDate: "2026-09-03",
          DateTime: "2026-09-03 10:00:00",
          Quantity: "+100",
          TradePrice: "100",
          NetCash: "-10000",
          "Notes/Codes": "O",
          TradeID: "T-STK",
          Multiplier: "1",
        }),
      ]);
      const ledger = await ledgerFrom(store, "lifecycle-decision.csv", rows);
      const option = exec(ledger, "T-OPT");
      const stock = exec(ledger, "T-STK");

      const consistent = decision(
        "lifecycle",
        {
          event: "assignment",
          sourceRef: sourceOf(option),
          targetRef: sourceOf(stock),
        },
        { sources: [sourceOf(option), sourceOf(stock)] },
      );
      const linked = groupStrategies(ledger, [consistent], resolveId);
      expect(linked.links.filter((l) => l.type === "assignment")).toHaveLength(
        1,
      );

      const inconsistentRows = buildExecutionTable([
        optionLeg("OPT", "T-OPT2", {
          Strike: "100",
          "Put/Call": "P",
          Quantity: "-1",
          NetCash: "200",
        }),
        executionRow({
          ClientAccountID: "SIM-Z",
          AssetClass: "STK",
          Symbol: "TEST",
          UnderlyingSymbol: "TEST",
          Conid: "7003",
          CurrencyPrimary: "USD",
          TradeDate: "2026-09-03",
          DateTime: "2026-09-03 10:00:00",
          Quantity: "+50",
          TradePrice: "100",
          NetCash: "-5000",
          "Notes/Codes": "O",
          TradeID: "T-STK2",
          Multiplier: "1",
        }),
      ]);
      const ledger2 = await ledgerFrom(
        store,
        "lifecycle-decision-bad.csv",
        inconsistentRows,
      );
      const option2 = exec(ledger2, "T-OPT2");
      const stock2 = exec(ledger2, "T-STK2");
      const inconsistent = decision(
        "lifecycle",
        {
          event: "assignment",
          sourceRef: sourceOf(option2),
          targetRef: sourceOf(stock2),
        },
        { sources: [sourceOf(option2), sourceOf(stock2)] },
      );
      const rejected = groupStrategies(ledger2, [inconsistent], resolveId);
      expect(
        rejected.links.filter((l) => l.type === "assignment"),
      ).toHaveLength(0);
      expect(rejected.issues.map((i) => i.code)).toContain(
        "LIFECYCLE_INCONSISTENT",
      );
    }));

  it("returns an empty projection for an empty ledger", () =>
    withStore(async (store) => {
      const ledger = await normalizeLedger(store, {
        parserVersion: "flex-v1",
        decisionWatermark: 0,
      });
      const projection = groupStrategies(ledger, [], resolveId);
      expect(projection.strategies).toHaveLength(0);
      expect(projection.allocations).toHaveLength(0);
      expect(projection.links).toHaveLength(0);
    }));
});

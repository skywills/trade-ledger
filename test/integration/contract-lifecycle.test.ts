import { describe, expect, it } from "vitest";
import { normalizeExecution } from "../../src/server/imports/normalization.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  LEDGER_PARSER_VERSION,
  normalizeLedger,
} from "../../src/server/ledger/normalize.js";
import { accountProjection } from "../../src/server/strategies/accounting.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import { validateLifecycle } from "../../src/server/strategies/lifecycle.js";
import {
  classifyLegs,
  sameInstrument,
} from "../../src/server/strategies/matching.js";
import {
  buildExecutionTable,
  type ExecutionFields,
} from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

function fields(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    ClientAccountID: "SIM",
    AssetClass: "OPT",
    Symbol: "VIX",
    UnderlyingSymbol: "VIX",
    Conid: "1",
    CurrencyPrimary: "USD",
    DateTime: "2026-10-01 10:00:00",
    Quantity: "-2",
    TradePrice: "0.19",
    Proceeds: "38",
    NetCash: "37",
    IBCommission: "-1",
    Taxes: "0",
    Expiry: "20261016",
    Strike: "20",
    "Put/Call": "C",
    "Notes/Codes": "O",
    TradeID: "open",
    ...overrides,
  };
}
function normalized(overrides: Record<string, string> = {}) {
  return normalizeExecution(
    {
      rowNumber: 2,
      kind: "execution",
      section: null,
      issues: [],
      fields: fields(overrides),
    },
    { importId: "test", rowNumber: 2 },
    "UTC",
  );
}
async function build(rows: Record<string, string>[]) {
  const { store, dispose } = await createTestStore();
  try {
    const preview = await previewImport(store, {
      filename: "contracts.csv",
      bytes: buildExecutionTable(rows as ExecutionFields[]),
      timezone: "UTC",
    });
    await commitImport(store, preview.id);
    const ledger = await normalizeLedger(store, {
      parserVersion: LEDGER_PARSER_VERSION,
      decisionWatermark: 0,
    });
    const projection = accountProjection(
      ledger,
      groupStrategies(
        ledger,
        [],
        (account, keys) => `${account}:${keys.join(",")}`,
      ),
    );
    return { ledger, projection };
  } finally {
    await dispose();
  }
}

describe("contract multipliers and lifecycle", () => {
  it.each([
    ["OPT", "GOOGL", "2", "4.64", "-928", "100"],
    ["OPT", "SPXW", "1", "5.20", "-520", "100"],
    ["OPT", "VIX", "-2", "0.19", "38", "100"],
    ["FUT", "TFN25", "1", "192.30", "-9615", "50"],
    ["FUT", "TFK25", "1", "191.50", "-9575", "50"],
    ["STK", "MSFT", "3", "371.24", "-1113.72", "1"],
  ])(
    "resolves %s %s from gross proceeds",
    (AssetClass, symbol, Quantity, TradePrice, Proceeds, multiplier) => {
      const result = normalized({
        AssetClass,
        Symbol: symbol,
        Quantity,
        TradePrice,
        Proceeds,
      });
      expect(result.execution?.instrument.multiplier).toBe(multiplier);
      expect(result.issues).toEqual([]);
    },
  );
  it("preserves explicit multipliers and leaves insufficient evidence unresolved", () => {
    expect(
      normalized({ Multiplier: "25" }).execution?.instrument.multiplier,
    ).toBe("25");
    for (const overrides of [
      { Proceeds: "" },
      { TradePrice: "0" },
      { Quantity: "0" },
      { Proceeds: "37.99" },
    ]) {
      expect(normalized(overrides).execution?.instrument.multiplier).toBeNull();
      expect(normalized(overrides).issues.map((i) => i.code)).toContain(
        "missing_multiplier",
      );
    }
  });
  it.each(["0", "-100"])("rejects invalid multiplier %s", (Multiplier) => {
    expect(normalized({ Multiplier }).execution).toBeNull();
  });
  it.each(["VIX", "SQQQ", "SQQQ2"])(
    "recognizes explicit zero-value expiry for %s without rewriting P&L",
    (symbol) => {
      const result = normalized({
        Symbol: symbol,
        DateTime: "2026-10-16 16:00:00",
        Quantity: "2",
        TradePrice: "0",
        Proceeds: "0",
        NetCash: "0",
        FifoPnlRealized: "37",
        "Notes/Codes": "C;Exp",
      });
      expect(result.execution).toMatchObject({
        event: "expiry",
        netCash: "0",
        brokerPnl: "37",
      });
    },
  );
  it("does not invent expiry before expiry, on missing prices, or over explicit events", () => {
    for (const overrides of [
      { DateTime: "2026-10-15" },
      { TradePrice: "" },
      { "Notes/Codes": "O" },
      { PositionActionID: "123" },
    ]) {
      expect(
        normalized({
          DateTime: "2026-10-16",
          TradePrice: "0",
          Proceeds: "0",
          NetCash: "0",
          "Notes/Codes": "C",
          ...overrides,
        }).execution?.event,
      ).toBe("trade");
    }
    expect(
      normalized({ TradePrice: "0", NetCash: "0", "Notes/Codes": "C;Off" })
        .execution?.event,
    ).toBe("cash_settlement");
  });
  it.each([
    ["-2", "38", "37", "2", "37"],
    ["2", "-38", "-39", "-2", "-39"],
  ])(
    "closes worthless options and retains profit or loss",
    async (Quantity, Proceeds, NetCash, closeQty, pnl) => {
      const { ledger, projection } = await build([
        fields({ Quantity, Proceeds, NetCash }),
        fields({
          TradeID: "close",
          DateTime: "2026-10-16 16:00:00",
          Quantity: closeQty,
          TradePrice: "0",
          Proceeds: "0",
          NetCash: "0",
          IBCommission: "0",
          FifoPnlRealized: pnl,
          "Notes/Codes": "C;Exp",
        }),
      ]);
      expect(
        ledger.executions.every((e) => e.instrument.multiplier === "100"),
      ).toBe(true);
      expect(ledger.issues.map((i) => i.code)).not.toContain(
        "missing_multiplier",
      );
      expect(projection.strategies).toHaveLength(1);
      expect(projection.strategies[0]).toMatchObject({
        status: "closed",
        complete: true,
        cashflow: pnl,
        brokerPnl: pnl,
        reconstructedPnl: pnl,
      });
    },
  );
  it("retains missing-opening evidence without mislabelling known expiry", async () => {
    const { projection } = await build([
      fields({
        DateTime: "2026-10-16",
        Quantity: "2",
        TradePrice: "0",
        Proceeds: "0",
        NetCash: "0",
        FifoPnlRealized: "37",
        "Notes/Codes": "C;Exp",
      }),
    ]);
    expect(projection.issues.map((i) => i.code)).toContain("MISSING_OPENING");
    expect(projection.issues.map((i) => i.code)).not.toContain(
      "LIFECYCLE_UNRESOLVED",
    );
    expect(projection.strategies[0]?.brokerPnl).toBe("37");
  });
  it("does not propagate conflicting contract multipliers", async () => {
    const { ledger } = await build([
      fields({ Multiplier: "100" }),
      fields({ TradeID: "other", Multiplier: "50", DateTime: "2026-10-02" }),
      fields({
        TradeID: "close",
        DateTime: "2026-10-16",
        Quantity: "2",
        TradePrice: "0",
        Proceeds: "0",
        NetCash: "0",
        "Notes/Codes": "C",
      }),
    ]);
    expect(
      ledger.executions.find((e) => e.brokerIds.TradeID === "close")?.instrument
        .multiplier,
    ).toBeNull();
    expect(ledger.issues.map((i) => i.code)).toContain(
      "conflicting_multiplier",
    );
  });
  it("keeps different contract IDs distinct and classifies futures separately", () => {
    const instrument = normalized().execution?.instrument;
    if (!instrument) throw new Error("Expected execution");
    expect(
      sameInstrument(instrument, { ...instrument, key: "conid:2", conid: "2" }),
    ).toBe(false);
    expect(
      classifyLegs([
        { instrument: { ...instrument, assetClass: "FUT" }, quantity: "1" },
      ]),
    ).toBe("long_future");
  });
});

it("settles an option in cash without a stock leg or duplicate P&L", async () => {
  const { ledger, projection } = await build([
    fields(),
    fields({
      TradeID: "settled",
      DateTime: "2026-10-16",
      Quantity: "2",
      TradePrice: "0.10",
      Proceeds: "-20",
      NetCash: "-20",
      IBCommission: "0",
      FifoPnlRealized: "17",
      "Notes/Codes": "C;Off",
    }),
  ]);
  expect(
    ledger.executions.find((e) => e.brokerIds.TradeID === "settled")?.event,
  ).toBe("cash_settlement");
  expect(projection.strategies).toHaveLength(1);
  expect(projection.strategies[0]).toMatchObject({
    status: "closed",
    complete: true,
    cashflow: "17",
    brokerPnl: "17",
    reconstructedPnl: "17",
  });
});
it("keeps odd-lot stock quantities and cashflow in share units", async () => {
  const { ledger, projection } = await build([
    fields({
      AssetClass: "STK",
      Symbol: "MSFT",
      UnderlyingSymbol: "MSFT",
      Expiry: "",
      Strike: "",
      "Put/Call": "",
      Quantity: "3",
      TradePrice: "371.24",
      Proceeds: "-1113.72",
      NetCash: "-1114.72",
    }),
  ]);
  expect(ledger.executions[0]?.instrument.multiplier).toBe("1");
  expect(projection.strategies[0]).toMatchObject({
    type: "stock",
    status: "open",
    complete: true,
    cashflow: "-1114.72",
    positions: [{ instrumentKey: "conid:1", quantity: "3" }],
  });
});
it("does not borrow a multiplier from a different contract", async () => {
  const { ledger } = await build([
    fields(),
    fields({
      TradeID: "expiry",
      Conid: "2",
      Symbol: "SQQQ2",
      DateTime: "2026-10-16",
      Quantity: "2",
      TradePrice: "0",
      Proceeds: "0",
      NetCash: "0",
      "Notes/Codes": "C",
    }),
  ]);
  expect(
    ledger.executions.find((e) => e.brokerIds.TradeID === "expiry")?.instrument
      .multiplier,
  ).toBeNull();
});

it("does not use adjusted option premium multipliers as share deliverables", () => {
  const option = normalized({
    Symbol: "SQQQ2",
    UnderlyingSymbol: "SQQQ",
    Multiplier: "100",
    "Notes/Codes": "A;C",
  }).execution;
  const stock = normalized({
    AssetClass: "STK",
    Symbol: "SQQQ",
    UnderlyingSymbol: "SQQQ",
    Quantity: "200",
  }).execution;
  if (!option || !stock) throw new Error("Expected executions");
  expect(validateLifecycle("assignment", option, stock)).toMatchObject({
    code: "LIFECYCLE_INCONSISTENT",
    severity: "warning",
  });
  expect(
    validateLifecycle(
      "assignment",
      { ...option, instrument: { ...option.instrument, assetClass: "FUT" } },
      stock,
    ),
  ).toMatchObject({ severity: "error" });
});

it("does not match weak identities with different option terms", () => {
  const instrument = normalized({ Conid: "" }).execution?.instrument;
  if (!instrument) throw new Error("Expected instrument");
  expect(
    sameInstrument(instrument, { ...instrument, expiry: "2026-11-20" }),
  ).toBe(false);
  expect(sameInstrument(instrument, { ...instrument, strike: "21" })).toBe(
    false,
  );
});
it("inherits a multiplier across an unambiguous missing contract ID and closes exposure", async () => {
  const { ledger, projection } = await build([
    fields(),
    fields({
      Conid: "",
      TradeID: "expiry",
      DateTime: "2026-10-16",
      Quantity: "2",
      TradePrice: "0",
      Proceeds: "0",
      NetCash: "0",
      FifoPnlRealized: "37",
      "Notes/Codes": "C;Exp",
    }),
  ]);
  expect(
    ledger.executions.find((e) => e.brokerIds.TradeID === "expiry")?.instrument
      .multiplier,
  ).toBe("100");
  expect(projection.strategies[0]).toMatchObject({
    status: "closed",
    complete: true,
  });
});
it.each([false, true])(
  "uses active revisions only when cancelled=%s",
  async (cancelled) => {
    const { ledger } = await build([
      fields({ Multiplier: "100" }),
      fields({
        TradeID: "correction",
        OrigTradeID: "open",
        Multiplier: "50",
        Quantity: cancelled ? "0" : "-2",
        Proceeds: cancelled ? "0" : "19",
        NetCash: cancelled ? "0" : "18",
      }),
      fields({
        TradeID: "expiry",
        DateTime: "2026-10-16",
        Quantity: "2",
        TradePrice: "0",
        Proceeds: "0",
        NetCash: "0",
        "Notes/Codes": "C",
      }),
    ]);
    expect(
      ledger.executions.find((e) => e.brokerIds.TradeID === "expiry")
        ?.instrument.multiplier,
    ).toBe(cancelled ? null : "50");
    expect(ledger.issues.map((i) => i.code)).not.toContain(
      "conflicting_multiplier",
    );
  },
);

it("gives distinct exposure keys to no-ID contracts sharing a root", () => {
  const left = normalized({ Conid: "", Strike: "20" }).execution?.instrument;
  const right = normalized({ Conid: "", Strike: "21" }).execution?.instrument;
  expect(left?.key).not.toBe(right?.key);
});
it.each([
  { ClientAccountID: "OTHER" },
  { CurrencyPrimary: "EUR" },
  { Conid: "", Strike: "21" },
  { Conid: "", Expiry: "20261015" },
])(
  "does not inherit across account, currency, or contract boundaries: %j",
  async (overrides) => {
    const { ledger } = await build([
      fields({ Conid: "" }),
      fields({
        Conid: "",
        TradeID: "expiry",
        DateTime: "2026-10-16",
        Quantity: "2",
        TradePrice: "0",
        Proceeds: "0",
        NetCash: "0",
        "Notes/Codes": "C",
        ...overrides,
      }),
    ]);
    expect(
      ledger.executions.find((e) => e.brokerIds.TradeID === "expiry")
        ?.instrument.multiplier,
    ).toBeNull();
  },
);
it("inherits complete no-ID contract evidence without conflating ambiguous known IDs", async () => {
  const close = fields({
    Conid: "",
    TradeID: "expiry",
    DateTime: "2026-10-16",
    Quantity: "2",
    TradePrice: "0",
    Proceeds: "0",
    NetCash: "0",
    "Notes/Codes": "C",
  });
  const noIds = await build([fields({ Conid: "" }), close]);
  expect(
    noIds.ledger.executions.find((e) => e.brokerIds.TradeID === "expiry")
      ?.instrument.multiplier,
  ).toBe("100");
  const ambiguous = await build([
    fields(),
    fields({ Conid: "2", TradeID: "other" }),
    close,
  ]);
  expect(
    ambiguous.ledger.executions.find((e) => e.brokerIds.TradeID === "expiry")
      ?.instrument.multiplier,
  ).toBeNull();
});

it.each(["0", "37", "-39"])(
  "does not infer expiry from zero cash or broker P&L %s without event codes",
  (pnl) => {
    const result = normalized({
      DateTime: "2026-10-16 16:00:00",
      Quantity: "2",
      TradePrice: "0",
      Proceeds: "0",
      NetCash: "0",
      FifoPnlRealized: pnl,
      "Notes/Codes": "C",
    });
    expect(result.execution).toMatchObject({
      event: "trade",
      netCash: "0",
      brokerPnl: pnl,
    });
  },
);

it.each([
  {
    actionId: "",
    event: "expiry",
    expected: { status: "closed", complete: true, reconstructedPnl: "37" },
  },
  {
    actionId: "unmatched-action",
    event: "expiry",
    expected: { status: "closed", complete: true, reconstructedPnl: "37" },
  },
  {
    actionId: "",
    event: "roll",
    expected: { status: "unresolved", complete: false, reconstructedPnl: null },
  },
])(
  "requires event evidence before final accounting ($actionId, correction=$event)",
  async ({ actionId, event, expected }) => {
    const { ledger, projection } = await build([
      fields(),
      fields({
        TradeID: "booked-close",
        DateTime: "2026-10-16 16:00:00",
        Quantity: "2",
        TradePrice: "0",
        Proceeds: "0",
        NetCash: "0",
        IBCommission: "0",
        FifoPnlRealized: "0",
        "Notes/Codes": "C",
        PositionActionID: actionId,
      }),
    ]);
    expect(projection.strategies).toHaveLength(1);
    expect(projection.strategies[0]).toMatchObject({
      status: "unresolved",
      complete: false,
      cashflow: "37",
      brokerPnl: "0",
      reconstructedPnl: null,
    });
    expect(projection.issues.map((i) => i.code)).toContain(
      "LIFECYCLE_UNRESOLVED",
    );
    expect(projection.issues.map((i) => i.code)).not.toContain(
      "MISSING_OPENING",
    );
    expect(projection.issues.map((i) => i.code)).not.toContain(
      "PNL_RECONCILIATION",
    );
    expect(projection.links).toEqual([]);
    const opening = ledger.executions.find((e) => e.action === "open");
    const close = ledger.executions.find(
      (e) => e.brokerIds.TradeID === "booked-close",
    );
    if (!opening || !close) throw new Error("Expected source executions");
    const corrected = accountProjection(
      ledger,
      groupStrategies(
        ledger,
        [
          {
            id: "confirm-expiry",
            sequence: 1,
            kind: "lifecycle",
            supersedesId: null,
            sources: [...opening.sources, ...close.sources],
            strategyIds: [],
            payload: {
              event,
              sourceRef: opening.sources[0],
              targetRef: close.sources[0],
            },
          },
        ],
        (account, keys) => `${account}:${keys.join(",")}`,
      ),
    );
    expect(corrected.strategies[0]).toMatchObject(expected);
    if (event === "expiry") {
      expect(corrected.issues.map((i) => i.code)).not.toContain(
        "LIFECYCLE_UNRESOLVED",
      );
    } else {
      expect(corrected.issues.map((i) => i.code)).toContain(
        "LIFECYCLE_UNRESOLVED",
      );
    }
  },
);

it.each([
  ["Ep", "expiry"],
  ["Ca", "unsupported"],
  ["Off", "cash_settlement"],
  ["S0", "cash_settlement"],
  ["S1", "cash_settlement"],
])(
  "interprets broker code %s according to its supplied definition",
  (code, event) => {
    const result = normalized({
      "Notes/Codes": code,
      "Open/CloseIndicator": "C",
      PositionActionID: "broker-action",
      DateTime: "2026-10-16 16:20:00",
      Quantity: "2",
      TradePrice: "0",
      Proceeds: "0",
      NetCash: "0",
    });
    expect(result.execution).toMatchObject({
      action: "close",
      event,
      netCash: "0",
    });
    expect(result.execution?.codes).toEqual([code]);
  },
);

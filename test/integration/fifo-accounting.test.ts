import { expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  buildExecutionTable,
  type ExecutionFields,
  executionRow,
} from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

function trade(
  id: string,
  day: string,
  quantity: string,
  cash: string,
  fields: ExecutionFields = {},
) {
  return executionRow({
    ClientAccountID: "A",
    CurrencyPrimary: "USD",
    AssetClass: "STK",
    Symbol: "XYZ",
    Conid: "1",
    DateTime: `2026-10-${day} 12:00:00`,
    Quantity: quantity,
    NetCash: cash,
    TradeID: id,
    "Notes/Codes": quantity.startsWith("-") ? "C" : "O",
    FifoPnlRealized: "0",
    IBCommission: "0",
    ...fields,
  });
}

async function projectionFor(
  rows: ExecutionFields[],
  timezone = "UTC",
  overlap?: ExecutionFields[],
  overlapTimezone = timezone,
) {
  const { store, dispose } = await createTestStore();
  try {
    const preview = await previewImport(store, {
      filename: "synthetic.csv",
      bytes: buildExecutionTable(rows),
      timezone,
    });
    await commitImport(store, preview.id);
    if (overlap) {
      const corroborating = await previewImport(store, {
        filename: "overlap.csv",
        bytes: buildExecutionTable(overlap),
        timezone: overlapTimezone,
      });
      await commitImport(store, corroborating.id);
    }
    await rebuild(store, {
      mode: "full",
      parserVersion: "flex-v1",
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    const projection = activeProjection(store).projection;
    if (!projection) throw Error("Missing active projection");
    return projection;
  } finally {
    await dispose();
  }
}

it("consumes the oldest remaining stock before spilling a second sale into the newer lot", async () => {
  const p = await projectionFor([
    trade("O1", "01", "100", "-10000"),
    trade("O2", "02", "100", "-9000"),
    trade("C1", "03", "-50", "5250", { FifoPnlRealized: "250" }),
    trade("C2", "04", "-80", "8400", { FifoPnlRealized: "700" }),
  ]);
  const owners = [...p.strategies].sort((a, b) =>
    (a.openingDate ?? "").localeCompare(b.openingDate ?? ""),
  );
  expect(owners.map((s) => s.positions[0]?.quantity)).toEqual(["0", "70"]);
  expect(
    owners.map((s) => {
      const sale = p.allocations.find(
        (a) => a.strategyId === s.id && a.executionKey.endsWith(":trade:C2"),
      );
      return [sale?.quantity, sale?.brokerPnl];
    }),
  ).toEqual([
    ["-50", "250"],
    ["-30", "450"],
  ]);
});

it.each([
  ["A", "2026-10-02 12:00:00", "10"],
  ["A", "20261002;120000", "10"],
  ["B", "2026-10-02 12:00:00", "50"],
])(
  "uses closed lot account %s and timestamp %s",
  async (account, timestamp, pnl) => {
    const p = await projectionFor([
      trade("O1", "01", "1", "-100"),
      trade("O2", "02", "1", "-140"),
      trade("TC", "03", "-1", "150"),
      {
        LevelOfDetail: "CLOSED_LOT",
        ClientAccountID: account,
        TradeID: "TC",
        OpenDateTime: timestamp,
        Quantity: "-1",
      },
    ]);
    expect(
      p.strategies.find((s) => s.status === "closed")?.reconstructedPnl,
    ).toBe(pnl);
  },
);

it.each([
  ["-100", "0", ["50", "-50"], false],
  ["", "0", ["0", "0"], true],
  ["-100", "100", ["50", "50"], true],
] as const)(
  "attributes a split futures close using reported proceeds %s and P&L %s",
  async (firstProceeds, closePnl, expected, estimated) => {
    const future = { AssetClass: "FUT", Expiry: "2026-12-18", Multiplier: "1" };
    const p = await projectionFor([
      trade("O1", "01", "1", "0", {
        ...future,
        Proceeds: firstProceeds,
        TradePrice: "100",
      }),
      trade("O2", "02", "1", "0", {
        ...future,
        Proceeds: "-200",
        TradePrice: "200",
      }),
      trade("TC", "03", "-2", "0", {
        ...future,
        Proceeds: "300",
        TradePrice: "150",
        FifoPnlRealized: closePnl,
      }),
    ]);
    const owners = [...p.strategies].sort((a, b) =>
      (a.openingDate ?? "").localeCompare(b.openingDate ?? ""),
    );
    expect(owners.map((s) => s.brokerPnl)).toEqual(expected);
    expect(
      p.allocations
        .filter((a) => a.role === "close")
        .map((a) => a.pnlEstimated),
    ).toEqual([estimated, estimated]);
    expect(p.allocations.map((a) => a.netCash)).toEqual(["0", "0", "0", "0"]);
  },
);

it("ranks remaining fills of one order around another order after its first fill is exhausted", async () => {
  const firstOrder = { IBOrderID: "order-A" };
  const p = await projectionFor([
    trade("A1", "01", "50", "-5000", firstOrder),
    trade("B", "02", "100", "-9000"),
    trade("A2", "03", "50", "-6000", firstOrder),
    trade("C1", "04", "-50", "5250", { FifoPnlRealized: "250" }),
    trade("C2", "05", "-80", "8400", { FifoPnlRealized: "1200" }),
    trade("C3", "06", "-30", "3150", { FifoPnlRealized: "150" }),
  ]);
  const owner = (id: string) =>
    p.allocations.find((a) => a.executionKey.endsWith(`:trade:${id}`))
      ?.strategyId;
  expect(
    p.allocations
      .filter((a) => a.executionKey.endsWith(":trade:C2"))
      .map((a) => [a.strategyId, a.quantity, a.brokerPnl]),
  ).toEqual([[owner("B"), "-80", "1200"]]);
  expect(
    p.allocations
      .filter((a) => a.executionKey.endsWith(":trade:C3"))
      .map((a) => [a.strategyId, a.quantity, a.brokerPnl])
      .sort(),
  ).toEqual(
    [
      [owner("A1"), "-10", "-150"],
      [owner("B"), "-20", "300"],
    ].sort(),
  );
});

it.each([
  "20261001;140000",
  "2026-10-01T14:00:00Z",
  "2026-10-01T16:00:00+02:00",
])(
  "uses opening instant %s to distinguish same-day closed lots",
  async (timestamp) => {
    const p = await projectionFor([
      trade("O1", "01", "1", "-100", { DateTime: "2026-10-01 10:00:00" }),
      trade("O2", "01", "1", "-140", { DateTime: "2026-10-01 14:00:00" }),
      trade("TC", "03", "-1", "150"),
      {
        LevelOfDetail: "CLOSED_LOT",
        ClientAccountID: "A",
        TradeID: "TC",
        OpenDateTime: timestamp,
        Quantity: "-1",
      },
    ]);
    expect(
      p.strategies.find((s) => s.status === "closed")?.reconstructedPnl,
    ).toBe("10");
  },
);

it("honors each same-account broker lot quantity including a partial older holding", async () => {
  const lot = (account: string, day: string, quantity: string) => ({
    LevelOfDetail: "CLOSED_LOT",
    ClientAccountID: account,
    TradeID: "C2",
    OpenDateTime: `202610${day};120000`,
    Quantity: quantity,
  });
  const p = await projectionFor([
    trade("O1", "01", "100", "-10000"),
    trade("O2", "02", "100", "-9000"),
    trade("C1", "03", "-50", "5250", { FifoPnlRealized: "250" }),
    trade("C2", "04", "-80", "8400", { FifoPnlRealized: "900" }),
    lot("B", "02", "-80"),
    lot("A", "02", "-50"),
    lot("A", "01", "-30"),
  ]);
  const owners = [...p.strategies].sort((a, b) =>
    (a.openingDate ?? "").localeCompare(b.openingDate ?? ""),
  );
  expect(owners.map((s) => s.positions[0]?.quantity)).toEqual(["20", "50"]);
  expect(
    owners.map(
      (s) =>
        p.allocations.find(
          (a) => a.strategyId === s.id && a.executionKey.endsWith(":trade:C2"),
        )?.brokerPnl,
    ),
  ).toEqual(["150", "750"]);
});

it("leaves a conflicting explicit opening instant for review", async () => {
  const p = await projectionFor([
    trade("O1", "01", "1", "-100"),
    trade("O2", "02", "1", "-140"),
    trade("TC", "03", "-1", "150"),
    {
      LevelOfDetail: "CLOSED_LOT",
      ClientAccountID: "A",
      TradeID: "TC",
      OpenDateTime: "2026-10-02T12:00:00-04:00",
      Quantity: "-1",
    },
  ]);
  expect(p.issues.map((i) => i.code)).toContain("AMBIGUOUS_CLOSE");
  expect(p.strategies.filter((s) => s.status === "closed")).toHaveLength(0);
});

it("converts the broker's offset into the opening's named New York clock", async () => {
  const p = await projectionFor(
    [
      trade("O1", "01", "1", "-100", {
        DateTime: "2026-10-01 12:00:00.123456700",
      }),
      trade("O2", "01", "1", "-140", {
        DateTime: "2026-10-01 12:00:00.123456789",
      }),
      trade("TC", "03", "-1", "150"),
      {
        LevelOfDetail: "CLOSED_LOT",
        ClientAccountID: "A",
        TradeID: "TC",
        OpenDateTime: "2026-10-01T16:00:00.123456789Z",
        Quantity: "-1",
      },
    ],
    "America/New_York",
  );
  expect(
    p.strategies.find((s) => s.status === "closed")?.reconstructedPnl,
  ).toBe("10");
});

it("leaves a date-only reference unresolved when two intraday fills qualify", async () => {
  const p = await projectionFor([
    trade("O1", "01", "1", "-100", { DateTime: "2026-10-01 10:00:00" }),
    trade("O2", "01", "1", "-140", { DateTime: "2026-10-01 14:00:00" }),
    trade("TC", "03", "-1", "150"),
    {
      LevelOfDetail: "CLOSED_LOT",
      ClientAccountID: "A",
      TradeID: "TC",
      OpenDateTime: "20261001",
      Quantity: "-1",
    },
  ]);
  expect(p.issues.map((i) => i.code)).toContain("AMBIGUOUS_CLOSE");
});

it("uses a unique dated reference without a quantity and corroborates it across reports", async () => {
  const row = {
    LevelOfDetail: "CLOSED_LOT",
    ClientAccountID: "A",
    TradeID: "TC",
    OpenDateTime: "20261002",
  };
  const p = await projectionFor(
    [
      trade("O1", "01", "1", "-100"),
      trade("O2", "02", "1", "-140"),
      trade("TC", "03", "-1", "150"),
      row,
    ],
    "UTC",
    [row],
  );
  expect(
    p.strategies.find((s) => s.status === "closed")?.reconstructedPnl,
  ).toBe("10");
});

it("marks a materially inconsistent stock close's split broker result estimated", async () => {
  const p = await projectionFor([
    trade("A", "01", "1", "-100"),
    trade("B", "02", "1", "-200"),
    trade("C", "03", "-2", "300", { FifoPnlRealized: "100" }),
  ]);
  const sales = p.allocations.filter((a) => a.role === "close");
  expect(sales.map((a) => [a.brokerPnl, a.pnlEstimated])).toEqual([
    ["50", true],
    ["50", true],
  ]);
});

it("corroborates a repeated lot in an export containing only part of the close", async () => {
  const lot = (day: string, quantity: string) => ({
    LevelOfDetail: "CLOSED_LOT",
    ClientAccountID: "A",
    TradeID: "C",
    OpenDateTime: `202610${day};120000`,
    Quantity: quantity,
  });
  const p = await projectionFor(
    [
      trade("A", "01", "3", "-300"),
      trade("B", "02", "3", "-420"),
      trade("C", "03", "-3", "450", { FifoPnlRealized: "70" }),
      lot("01", "-1"),
      lot("02", "-2"),
    ],
    "UTC",
    [lot("02", "-2")],
  );
  expect(
    p.allocations
      .filter((a) => a.role === "close")
      .map((a) => [a.quantity, a.brokerPnl])
      .sort(),
  ).toEqual([
    ["-1", "50"],
    ["-2", "20"],
  ]);
});

it("selects the New York fill that fell on the UTC lot report's opening date", async () => {
  const p = await projectionFor(
    [
      trade("earlier", "01", "1", "-100", { DateTime: "2026-10-01 23:30:00" }),
      trade("later", "02", "1", "-140", { DateTime: "2026-10-02 23:30:00" }),
      trade("sale", "06", "-1", "150"),
    ],
    "America/New_York",
    [
      {
        LevelOfDetail: "CLOSED_LOT",
        ClientAccountID: "A",
        TradeID: "sale",
        OpenDateTime: "20261002",
        Quantity: "-1",
      },
    ],
    "UTC",
  );
  const owner = (id: string) =>
    p.allocations.find((a) => a.executionKey.endsWith(`:trade:${id}`))
      ?.strategyId;
  expect(owner("earlier")).toBeTruthy();
  expect(owner("sale")).toBe(owner("earlier"));
});

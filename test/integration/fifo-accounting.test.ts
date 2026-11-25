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

async function projectionFor(rows: ExecutionFields[]) {
  const { store, dispose } = await createTestStore();
  try {
    const preview = await previewImport(store, {
      filename: "synthetic.csv",
      bytes: buildExecutionTable(rows),
      timezone: "UTC",
    });
    await commitImport(store, preview.id);
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

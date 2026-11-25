import { expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { readAnalyticsSnapshot } from "../../src/server/analytics/snapshot.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { groupMergeInput } from "../../src/server/decisions/schemas.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

const input = {
  mode: "full" as const,
  parserVersion: "flex-v1",
  algorithmVersion: ALGORITHM_VERSION,
  signal: new AbortController().signal,
};
function row(
  id: string,
  asset: string,
  quantity: string,
  cash: string,
  day: number,
  codes: string,
  extra: Record<string, string> = {},
) {
  return executionRow({
    ClientAccountID: "A",
    AssetClass: asset,
    Symbol: "XYZ",
    UnderlyingSymbol: "XYZ",
    Conid: asset === "STK" ? "1" : "2",
    CurrencyPrimary: "USD",
    TradeDate: `2026-10-${String(day).padStart(2, "0")}`,
    DateTime: `2026-10-${String(day).padStart(2, "0")} 12:00:00`,
    Quantity: quantity,
    NetCash: cash,
    TradePrice: "1",
    TradeID: id,
    IBExecID: id,
    IBOrderID: id,
    BrokerageOrderID: id,
    "Notes/Codes": codes,
    Multiplier: asset === "STK" ? "1" : "100",
    Expiry: asset === "STK" ? "" : "2026-10-16",
    Strike: asset === "STK" ? "" : "100",
    "Put/Call": asset === "STK" ? "" : "P",
    ...extra,
  });
}
async function commit(
  t: Awaited<ReturnType<typeof createTestStore>>,
  rows: Record<string, string>[],
  name: string,
) {
  const p = await previewImport(t.store, {
    filename: name,
    bytes: new TextEncoder().encode(
      new TextDecoder()
        .decode(buildExecutionTable(rows))
        .split("\n")
        .map(
          (line, i) =>
            line +
            "," +
            (i === 0
              ? "PositionActionID"
              : (rows[i - 1]?.PositionActionID ?? "")),
        )
        .join("\n"),
    ),
    timezone: "UTC",
  });
  await commitImport(t.store, p.id);
  await rebuild(t.store, input);
}
it("imports assignment, attaches a call before close import, and reports one completed wheel cycle", async () => {
  const t = await createTestStore();
  try {
    await commit(
      t,
      [
        row("po", "OPT", "-1", "200", 1, "O"),
        row("pa", "OPT", "1", "0", 2, "C;A", {
          PositionActionID: "put-assignment",
        }),
        row("so", "STK", "100", "-10000", 2, "O;A", {
          PositionActionID: "put-assignment",
        }),
        row("co", "OPT", "-1", "100", 3, "O", {
          Conid: "3",
          "Put/Call": "C",
          Strike: "105",
          Expiry: "2026-11-20",
        }),
      ],
      "open.csv",
    );
    const active = activeProjection(t.store).projection;
    const data = active?.lifecycles;
    expect(data?.suggestions).toHaveLength(1);
    const suggestion = data?.suggestions[0];
    if (!suggestion) throw Error("missing suggestion");
    const originId = suggestion.candidateLifecycleIds[0];
    if (!originId) throw Error("missing origin");
    await appendDecision(
      t.store,
      {
        kind: "lifecycle_attachment",
        clientRequestId: "accept-call",
        author: "user",
        payload: {
          opening: suggestion.callOpening,
          targets: [{ lifecycleId: originId, quantity: "-1" }],
        },
      },
      decisionWatermark(t.store),
    );
    await rebuild(t.store, input);
    expect(
      activeProjection(t.store).projection?.lifecycles?.lifecycles,
    ).toHaveLength(1);
    expect(
      aggregateAnalytics(readAnalyticsSnapshot(t.store), {
        basis: "reconstructed",
        currency: "USD",
      }).performance.closed,
    ).toBe(0);
    await commit(
      t,
      [
        row("cc", "OPT", "1", "0", 8, "C;A", {
          PositionActionID: "call-away",
          Conid: "3",
          "Put/Call": "C",
          Strike: "105",
          Expiry: "2026-11-20",
        }),
        row("sc", "STK", "-100", "10500", 8, "C;A", {
          PositionActionID: "call-away",
        }),
      ],
      "closed.csv",
    );
    let snapshot = readAnalyticsSnapshot(t.store);
    let result = aggregateAnalytics(snapshot, {
      basis: "reconstructed",
      currency: "USD",
    });
    expect(result.performance).toMatchObject({
      closed: 1,
      eligible: 1,
      wins: 1,
      losses: 0,
      pnl: "800",
    });
    expect(snapshot.projection?.lifecycles?.lifecycles[0]?.id).toBe(originId);
    const components = snapshot.projection?.strategies ?? [];
    expect(components.length).toBeGreaterThan(1);
    const chosen = components[0];
    if (!chosen) throw Error("missing component");
    await appendDecision(
      t.store,
      groupMergeInput({
        chosenStrategyId: chosen.id,
        mergedStrategyIds: components.slice(1).map((s) => s.id),
      }),
      decisionWatermark(t.store),
    );
    await rebuild(t.store, input);
    snapshot = readAnalyticsSnapshot(t.store);
    result = aggregateAnalytics(snapshot, {
      basis: "reconstructed",
      currency: "USD",
    });
    expect(result.performance).toMatchObject({ closed: 1, pnl: "800" });
    expect(snapshot.projection?.lifecycles?.lifecycles[0]?.id).toBe(originId);
    expect(t.store.db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    await t.dispose();
  }
});
it("splits a stock close across two independent opening lots FIFO", async () => {
  const t = await createTestStore();
  try {
    await commit(
      t,
      [
        row("buy1", "STK", "100", "-10000", 1, "O"),
        row("buy2", "STK", "100", "-10000", 2, "O"),
        row("shared-sale", "STK", "-200", "21000", 8, "C"),
      ],
      "shared.csv",
    );
    // IBKR matches the 200-share sale FIFO across both 100-share lots, so no
    // manual split decision is needed.
    const projection = activeProjection(t.store).projection;
    if (!projection?.lifecycles) throw Error("missing lifecycle projection");
    expect(projection.issues.map((i) => i.code)).not.toContain(
      "LIFECYCLE_EXPOSURE_UNRESOLVED",
    );
    const result = aggregateAnalytics(readAnalyticsSnapshot(t.store), {
      basis: "reconstructed",
      currency: "USD",
    });
    expect(result.performance).toMatchObject({
      closed: 2,
      eligible: 2,
      wins: 2,
      pnl: "1000",
    });
  } finally {
    await t.dispose();
  }
});

function assignedStockLots() {
  return ["older", "newer"].flatMap((lot, index) => {
    const day = 2 + index;
    const strike = index === 0 ? "100" : "90";
    const contract = { Strike: strike, Conid: String(22 + index) };
    return [
      row(lot, "OPT", "-1", "200", 1, "O", contract),
      row(`${lot}-assigned`, "OPT", "1", "0", day, "A;C", {
        ...contract,
        PositionActionID: lot,
        TradePrice: "0",
        FifoPnlRealized: "200",
      }),
      row(
        `${lot}-shares`,
        "STK",
        "100",
        index === 0 ? "-10000" : "-9000",
        day,
        "A;O",
        {
          PositionActionID: lot,
          TradePrice: strike,
          IBOrderID: "stock-position",
          BrokerageOrderID: "stock-position",
        },
      ),
    ];
  });
}

it("keeps the remaining older assigned shares first in a subsequent FIFO sale", async () => {
  const t = await createTestStore();
  try {
    await commit(
      t,
      [
        ...assignedStockLots(),
        row("first-sale", "STK", "-50", "5250", 5, "C", {
          TradePrice: "105",
          FifoPnlRealized: "250",
        }),
        row("second-sale", "STK", "-80", "8400", 8, "C", {
          TradePrice: "105",
          FifoPnlRealized: "700",
        }),
      ],
      "partial.csv",
    );
    const cycles = activeProjection(t.store).projection?.lifecycles;
    if (!cycles) throw Error("Expected lifecycles");
    for (const [opening, quantity, pnl, balance] of [
      ["older", "-50", "250", "0"],
      ["newer", "-30", "450", "70"],
    ]) {
      const cycle = cycles.lifecycles.find(
        (l) => l.originOpeningExecutionKey === `txn:A:trade:${opening}`,
      );
      expect(cycle).toBeDefined();
      expect(
        cycle?.positions.find((pos) => pos.instrumentKey === "conid:1")
          ?.quantity ?? "0",
      ).toBe(balance);
      expect(
        cycles.members.find(
          (m) =>
            m.lifecycleId === cycle?.id &&
            m.allocation.executionKey === "txn:A:trade:second-sale",
        ),
      ).toMatchObject({ quantity, brokerPnl: pnl });
    }

    // The user can explicitly place all 80 shares on the later holding.
    const newer = cycles.lifecycles.find(
      (l) => l.originOpeningExecutionKey === "txn:A:trade:newer",
    );
    const sale = cycles.members.find(
      (m) => m.allocation.executionKey === "txn:A:trade:second-sale",
    );
    if (!newer || !sale) throw Error("Expected newer holding and sale");
    await appendDecision(
      t.store,
      {
        kind: "lifecycle_membership",
        author: "user",
        clientRequestId: "manual-lot",
        payload: {
          assignments: [
            {
              allocation: sale.allocation,
              lifecycleId: newer.id,
              quantity: "-80",
            },
          ],
        },
      },
      0,
    );
    expect((await rebuild(t.store, input)).status).toBe("active");
    expect(
      activeProjection(t.store).projection?.lifecycles?.members.filter(
        (m) => m.allocation.executionKey === sale.allocation.executionKey,
      ),
    ).toMatchObject([
      { lifecycleId: newer.id, quantity: "-80", brokerPnl: "700" },
    ]);
  } finally {
    await t.dispose();
  }
});

it.each([false, true])(
  "preserves lot-specific broker P&L through a persisted rebuild (merge=%s)",
  async (merge) => {
    const t = await createTestStore();
    try {
      await commit(
        t,
        [
          ...assignedStockLots(),
          row("sell-all", "STK", "-200", "21000", 8, "C", {
            TradePrice: "105",
            FifoPnlRealized: "2000",
          }),
        ],
        "lot-pnl.csv",
      );
      if (merge) {
        const components =
          activeProjection(t.store).projection?.strategies ?? [];
        const chosen = components[0];
        if (!chosen) throw Error("Expected components");
        await appendDecision(
          t.store,
          groupMergeInput({
            chosenStrategyId: chosen.id,
            mergedStrategyIds: components.slice(1).map((s) => s.id),
          }),
          0,
        );
        expect((await rebuild(t.store, input)).status).toBe("active");
      }
      const cycles = activeProjection(t.store).projection?.lifecycles;
      if (!cycles) throw Error("Expected lifecycles");
      for (const [opening, salePnl, cyclePnl] of [
        ["older", "500", "700"],
        ["newer", "1500", "1700"],
      ]) {
        const cycle = cycles.lifecycles.find(
          (l) => l.originOpeningExecutionKey === `txn:A:trade:${opening}`,
        );
        expect(
          cycles.members.find(
            (m) =>
              m.lifecycleId === cycle?.id &&
              m.allocation.executionKey === "txn:A:trade:sell-all",
          ),
        ).toMatchObject({
          brokerPnl: salePnl,
          estimated: false,
          pnlAttribution: "basis-reconciled",
        });
        expect(cycle).toMatchObject({
          status: "closed",
          brokerPnl: cyclePnl,
          reconstructedPnl: cyclePnl,
        });
      }
      expect(cycles.issues.map((i) => i.code)).not.toContain(
        "PNL_RECONCILIATION",
      );
    } finally {
      await t.dispose();
    }
  },
);

it.each([
  ["P", "XYZ", "100", true],
  ["P", "XYZ", "-100", false],
  ["P", "OTHER", "100", false],
  ["C", "XYZ", "-100", true],
  ["C", "XYZ", "100", false],
  ["C", "OTHER", "-100", false],
] as const)(
  "checks the underlying and signed share delivery for a %s assignment to %s, quantity %s",
  async (putCall, symbol, quantity, valid) => {
    const t = await createTestStore();
    try {
      await commit(
        t,
        [
          row("option", "OPT", "-1", "200", 1, "O", { "Put/Call": putCall }),
          row("booked", "OPT", "1", "0", 2, "C", {
            "Put/Call": putCall,
            TradePrice: "0",
            FifoPnlRealized: "200",
          }),
          row(
            "shares",
            "STK",
            quantity,
            String(-Number(quantity) * 100),
            2,
            "O",
            { Symbol: symbol, UnderlyingSymbol: "", TradePrice: "100" },
          ),
        ],
        "correction.csv",
      );
      const p = activeProjection(t.store).projection;
      const source = p?.issues.find((i) => i.code === "LIFECYCLE_UNRESOLVED")
        ?.sources[0];
      if (!source) throw Error("Expected unresolved booked close");
      await appendDecision(
        t.store,
        {
          kind: "lifecycle",
          author: "user",
          clientRequestId: "assign",
          payload: {
            event: "assignment",
            sourceRef: source,
            targetRef: { importId: source.importId, rowNumber: 4 },
          },
        },
        0,
      );
      expect((await rebuild(t.store, input)).status).toBe("active");
      const result = activeProjection(t.store).projection;
      expect(result?.links.filter((l) => l.type === "assignment")).toHaveLength(
        valid ? 1 : 0,
      );
      expect(
        result?.strategies.find(
          (s) => s.type === (putCall === "P" ? "short_put" : "short_call"),
        ),
      ).toMatchObject(
        valid
          ? { status: "closed", complete: true, reconstructedPnl: "200" }
          : { status: "unresolved", complete: false, reconstructedPnl: null },
      );
    } finally {
      await t.dispose();
    }
  },
);

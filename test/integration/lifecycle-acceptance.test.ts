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
it("resolves a real orphan stock close split across two independent opening lots", async () => {
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
    const projection = activeProjection(t.store).projection;
    if (!projection?.lifecycles) throw Error("missing lifecycle projection");
    const source = projection.allocations.find((a) =>
      a.executionKey.endsWith(":shared-sale"),
    );
    if (!source) throw Error("missing shared close");
    const targets = projection.lifecycles.lifecycles.filter((l) =>
      l.positions.some((p) => p.quantity === "100"),
    );
    expect(targets).toHaveLength(2);
    await appendDecision(
      t.store,
      {
        kind: "lifecycle_membership",
        clientRequestId: "split-sale",
        author: "user",
        payload: {
          assignments: targets.map((l) => ({
            lifecycleId: l.id,
            allocation: {
              strategyId: source.strategyId,
              executionKey: source.executionKey,
              role: source.role,
            },
            quantity: "-100",
          })),
        },
      },
      decisionWatermark(t.store),
    );
    await rebuild(t.store, input);
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

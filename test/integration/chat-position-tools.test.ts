import { afterEach, expect, it } from "vitest";
import type { AnalyticsSnapshot } from "../../src/server/analytics/snapshot.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { createChatTools } from "../../src/server/chat/tools/index.js";
import { appendDecision } from "../../src/server/decisions/service.js";
import type {
  Execution,
  Instrument,
  LedgerSnapshot,
  Projection,
  Strategy,
} from "../../src/shared/domain.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { seedLedger } from "../helpers/chat.js";
import { callTool, toolContext, toolJson } from "../helpers/chat-tools.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((t) => t.dispose()));
});
const stock: Instrument = {
  key: "stock",
  assetClass: "STK",
  symbol: "XYZ",
  underlying: "XYZ",
  conid: "1",
  expiry: null,
  strike: null,
  putCall: null,
  multiplier: "1",
};
function snapshot(
  entries: {
    id: string;
    quantity: string;
    account?: string;
    instrument?: Instrument;
    currency?: string;
  }[],
): AnalyticsSnapshot & { ledger: LedgerSnapshot; projection: Projection } {
  const executions: Execution[] = entries.map((e) => ({
    key: e.id,
    account: e.account ?? "A",
    instrument: e.instrument ?? stock,
    date: "2026-01-01",
    rawDateTime: "2026-01-01 00:00:00",
    timezone: "UTC",
    quantity: e.quantity,
    price: "100",
    currency: e.currency ?? "USD",
    netCash: "0",
    proceeds: null,
    commission: null,
    taxes: null,
    basis: null,
    brokerPnl: null,
    action: "open",
    event: "trade",
    brokerIds: {},
    codes: [],
    sources: [],
  }));
  const strategies: Strategy[] = entries.map((e, i) => ({
    id: e.id,
    type: "stock",
    currency: e.currency ?? "USD",
    description: "XYZ",
    openingDate: "2026-01-01",
    closeDate: null,
    expiry: executions[i]?.instrument.expiry ?? null,
    expiryYear: null,
    status: "open",
    complete: true,
    openingAmount: null,
    cashflow: null,
    brokerPnl: null,
    reconstructedPnl: null,
    positions: [
      { instrumentKey: (e.instrument ?? stock).key, quantity: e.quantity },
    ],
    reasons: [],
  }));
  return {
    buildId: "build",
    ledgerId: "ledger",
    stale: false,
    generatedAt: "2026-10-20T00:00:00Z",
    ledger: {
      id: "ledger",
      inputHash: "hash",
      executions,
      lots: [],
      issues: [],
      conflicts: 0,
    },
    projection: {
      ledgerId: "ledger",
      watermark: 0,
      strategies,
      allocations: executions.map((e) => ({
        strategyId: e.key,
        executionKey: e.key,
        quantity: e.quantity,
        netCash: "0",
        brokerPnl: null,
        pnlEstimated: false,
        role: "open",
      })),
      links: [],
      issues: [],
    },
  };
}
async function select(s: AnalyticsSnapshot, query = {}) {
  const { selectOpenPositions } = await import(
    "../../src/server/analytics/open-positions.js"
  );
  return selectOpenPositions(s, query);
}
it("partial_close_uses_remaining_quantity", async () => {
  const s = snapshot([{ id: "s", quantity: "100" }]);
  const e = s.ledger?.executions[0],
    p = s.projection;
  if (!e || !p?.strategies[0]) throw new Error("fixture");
  required(p.strategies[0].positions[0]).quantity = "40";
  s.ledger.executions.push({
    ...e,
    key: "close",
    quantity: "-60",
    action: "close",
  });
  p.allocations.push({
    ...required(p.allocations[0]),
    executionKey: "close",
    quantity: "-60",
    role: "close",
  });
  expect((await select(s)).items[0]?.netQuantity).toBe("40");
});
it("distinct_accounts_and_contracts_stay_separate", async () => {
  const call = {
    ...stock,
    key: "call105",
    assetClass: "OPT",
    expiry: "2026-01-01",
    strike: "105",
    putCall: "C" as const,
    multiplier: "100",
  };
  const result = await select(
    snapshot([
      { id: "a", quantity: "1" },
      { id: "b", quantity: "2", account: "B" },
      { id: "c", quantity: "-1", instrument: call },
      {
        id: "d",
        quantity: "-2",
        instrument: { ...call, key: "call110", strike: "110" },
      },
      { id: "eur", quantity: "3", currency: "EUR" },
    ]),
  );
  expect(result.items).toHaveLength(5);
  expect(
    result.items.find((r) => r.instrument.key === "call105")?.netQuantity,
  ).toBe("-1");
});
it("opposing_contributors_keep_gross_and_zero_net_row", async () => {
  const result = await select(
    snapshot([
      { id: "a", quantity: "100" },
      { id: "b", quantity: "-100" },
    ]),
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    netQuantity: "0",
    longQuantity: "100",
    shortQuantity: "100",
    strategyCount: 2,
  });
  expect(result.contributions.map((c) => c.quantity)).toEqual(["100", "-100"]);
  expect(
    (
      await select(
        snapshot([
          { id: "a", quantity: "0.1" },
          { id: "b", quantity: "0.2" },
        ]),
      )
    ).items[0]?.netQuantity,
  ).toBe("0.3");
});
it("missing_or_conflicting_account_is_disclosed", async () => {
  const s = snapshot([
    { id: "missing", quantity: "1", account: "" },
    { id: "conflict", quantity: "2" },
    { id: "orphan", quantity: "3" },
  ]);
  const e = required(s.ledger.executions[1]);
  s.ledger.executions.push({ ...e, key: "conflict2", account: "B" });
  s.projection.allocations.push({
    ...required(s.projection.allocations[1]),
    executionKey: "conflict2",
  });
  s.ledger.executions = s.ledger.executions.filter((e) => e.key !== "orphan");
  const result = await select(s);
  expect(result.items).toEqual([]);
  expect(result.unresolved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        strategyId: "missing",
        reason: "missing_account",
      }),
      expect.objectContaining({
        strategyId: "conflict",
        reason: "conflicting_account",
      }),
      expect.objectContaining({
        strategyId: "orphan",
        reason: "missing_instrument",
      }),
    ]),
  );
  const scoped = await select(s, { account: "A" });
  expect(scoped.unresolved).toEqual([]);
  expect(scoped.unscopedUnresolvedCount).toBe(3);
});
it("currency mismatch is unresolved instead of assigned to strategy currency", async () => {
  const s = snapshot([{ id: "s", quantity: "1" }]);
  required(s.ledger.executions[0]).currency = "EUR";
  expect((await select(s)).unresolved[0]?.reason).toBe("conflicting_currency");
});
it("expiry_metadata_alone_does_not_zero_position", async () => {
  const s = snapshot([
    {
      id: "s",
      quantity: "-1",
      instrument: {
        ...stock,
        key: "expired",
        assetClass: "OPT",
        expiry: "2000-01-01",
        strike: "100",
        putCall: "C",
        multiplier: "100",
      },
    },
  ]);
  expect((await select(s)).items[0]?.netQuantity).toBe("-1");
});
it("lifecycle links require matching allocation references without adding quantities", async () => {
  const s = snapshot([{ id: "s", quantity: "40" }]);
  s.projection.lifecycles = {
    version: 1,
    lifecycles: [],
    campaigns: [],
    suggestions: [],
    issues: [],
    valuations: [],
    members: [
      {
        lifecycleId: "correct",
        allocation: { strategyId: "s", executionKey: "s", role: "open" },
        quantity: "100",
        netCash: "0",
        brokerPnl: null,
        estimated: false,
        sources: [],
      },
      {
        lifecycleId: "wrong",
        allocation: { strategyId: "other", executionKey: "s", role: "open" },
        quantity: "100",
        netCash: "0",
        brokerPnl: null,
        estimated: false,
        sources: [],
      },
    ],
  };
  const r = await select(s);
  expect(r.items[0]).toMatchObject({ netQuantity: "40", lifecycleCount: 1 });
  expect(r.contributions[0]?.lifecycleIds).toEqual(["correct"]);
});
it("large_contributors_page_without_truncation and strict build pinning", async () => {
  const t = await createTestStore();
  stores.push(t);
  const { buildId } = await seedLedger(
    t.store,
    buildExecutionTable(
      Array.from({ length: 120 }, (_, i) =>
        executionRow({
          ClientAccountID: "A",
          CurrencyPrimary: "USD",
          TradeDate: "2026-10-01",
          DateTime: "2026-10-01 12:00:00",
          AssetClass: "STK",
          Symbol: "XYZ",
          UnderlyingSymbol: "XYZ",
          Conid: "1",
          Multiplier: "1",
          Quantity: "1",
          NetCash: "-100",
          TradePrice: "100",
          IBExecID: `e${i}`,
          TradeID: `t${i}`,
          IBOrderID: `o${i}`,
          "Notes/Codes": "O",
        }),
      ),
    ),
  );
  const tools = createChatTools(toolContext(t.store));
  const rows: { strategyId: string; quantity: string }[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await toolJson(tools, "get_open_positions_summary", {
      section: "contributors",
      expectedBuildId: buildId,
      offset,
    });
    rows.push(...page.items);
    offset = page.nextOffset;
    expect(page.total).toBe(120);
  }
  expect(rows).toHaveLength(120);
  expect(new Set(rows.map((r) => r.strategyId)).size).toBe(120);
  expect(rows.every((r) => r.quantity === "1")).toBe(true);
  const p = await toolJson(tools, "get_open_positions_summary", {
    expectedBuildId: buildId,
  });
  expect(p.items[0]).toMatchObject({
    netQuantity: "120",
    longQuantity: "120",
    shortQuantity: "0",
  });
  expect(p.totalPositionGroups).toBe(1);
  expect(
    await callTool(tools, "get_open_positions_summary", {
      expectedBuildId: "old",
    }),
  ).toMatchObject({ isError: true });
  expect(
    await callTool(tools, "get_open_positions_summary", {
      url: "https://example.com",
    }),
  ).toMatchObject({ isError: true });
});

it.each(["xyz", "value:XYZ", "value:xyz"])(
  "underlying filter accepts established journal form %s",
  async (underlying) => {
    expect(
      (await select(snapshot([{ id: "s", quantity: "1" }]), { underlying }))
        .items,
    ).toHaveLength(1);
  },
);
it.each(["brk-b", "value:BRK B"])(
  "underlying filter retains symbol aliases for %s",
  async (underlying) => {
    const s = snapshot([
      { id: "s", quantity: "1", instrument: { ...stock, underlying: "BRK.B" } },
    ]);
    expect((await select(s, { underlying })).items).toHaveLength(1);
  },
);
it("one merged contributor with 1000 lifecycles has independently pageable links", async () => {
  const t = await createTestStore();
  stores.push(t);
  await seedLedger(
    t.store,
    buildExecutionTable(
      Array.from({ length: 1000 }, (_, i) =>
        executionRow({
          ClientAccountID: "A",
          CurrencyPrimary: "USD",
          TradeDate: "2026-10-01",
          DateTime: "2026-10-01 12:00:00",
          AssetClass: "STK",
          Symbol: "XYZ",
          UnderlyingSymbol: "XYZ",
          Conid: "1",
          Multiplier: "1",
          Quantity: "1",
          NetCash: "-100",
          TradePrice: "100",
          IBExecID: `e${i}`,
          TradeID: `t${i}`,
          IBOrderID: `o${i}`,
          "Notes/Codes": "O",
        }),
      ),
    ),
  );
  const before = required(activeProjection(t.store).projection ?? undefined);
  const chosen = required(before.strategies[0]).id;
  await appendDecision(
    t.store,
    {
      kind: "group_merge",
      clientRequestId: "large-merge",
      author: "user",
      payload: {
        chosenStrategyId: chosen,
        mergedStrategyIds: before.strategies.slice(1).map((s) => s.id),
      },
    },
    0,
  );
  await rebuild(t.store, {
    mode: "full",
    parserVersion: "flex-v1",
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
  const current = activeProjection(t.store);
  expect(current.projection?.strategies).toHaveLength(1);
  const expectedIds =
    current.projection?.lifecycles?.lifecycles.map((l) => l.id) ?? [];
  expect(expectedIds).toHaveLength(1000);
  const tools = createChatTools(toolContext(t.store));
  const contributors = await toolJson(tools, "get_open_positions_summary", {
    section: "contributors",
    limit: 1,
    expectedBuildId: current.buildId,
  });
  expect(contributors.total).toBe(1);
  expect(contributors.items[0]).toMatchObject({
    strategyId: chosen,
    quantity: "1000",
    lifecycleCount: 1000,
  });
  expect(contributors.items[0]).not.toHaveProperty("lifecycleIds");
  expect(contributors.nextOffset).toBeNull();
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await toolJson(tools, "get_open_positions_summary", {
      section: "lifecycle_links",
      offset,
      expectedBuildId: current.buildId,
    });
    expect(page.total).toBe(1000);
    expect(page.items.length).toBeLessThanOrEqual(50);
    for (const item of page.items) {
      expect(item.strategyId).toBe(chosen);
      expect(item).not.toHaveProperty("quantity");
      ids.push(item.lifecycleId);
    }
    offset = page.nextOffset;
  }
  expect(ids).toHaveLength(1000);
  expect(new Set(ids)).toEqual(new Set(expectedIds));
}, 20000);

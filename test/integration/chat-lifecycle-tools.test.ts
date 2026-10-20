import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { createChatTools } from "../../src/server/chat/tools/index.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import { registerLifecycleRoutes } from "../../src/server/http/routes-lifecycles.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { analyticsApp } from "../helpers/analytics-app.js";
import { seedLedger } from "../helpers/chat.js";
import { callTool, toolContext, toolJson } from "../helpers/chat-tools.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});
async function setup(bytes?: Uint8Array) {
  const t = await createTestStore();
  stores.push(t);
  await seedLedger(t.store, bytes);
  return { ...t, tools: createChatTools(toolContext(t.store)) };
}

it("lifecycle_matches_existing_route_evidence and rejects_unknown_or_other_build_ids", async () => {
  const { store, tools } = await setup();
  const app = Fastify();
  await registerLifecycleRoutes(app, store);
  try {
    const list = await toolJson(tools, "list_lifecycles");
    const id = list.items[0].id;
    const route = (await app.inject(`/api/lifecycles/${id}`)).json();
    for (const section of ["members", "executions", "suggestions"]) {
      const detail = await toolJson(tools, "get_lifecycle", {
        lifecycleId: id,
        expectedBuildId: list.buildId,
        section,
      });
      expect(detail.items).toEqual(route[section]);
      expect(detail.lifecycle).toMatchObject({
        id,
        brokerPnl: "-451.660745",
        status: "closed",
      });
      expect(detail).not.toHaveProperty("members");
      expect(detail).not.toHaveProperty("executions");
    }
    for (const input of [
      { lifecycleId: "unknown" },
      { lifecycleId: id, expectedBuildId: "old" },
    ])
      expect(await callTool(tools, "get_lifecycle", input)).toMatchObject({
        isError: true,
      });
  } finally {
    await app.close();
  }
});

it("campaign_counts_cycle_once and matches existing campaign route", async () => {
  const { store, tools } = await setup();
  const cycle = activeProjection(store).projection?.lifecycles?.lifecycles[0];
  if (!cycle) throw new Error("No cycle");
  await appendDecision(
    store,
    {
      kind: "wheel_campaign",
      clientRequestId: "campaign",
      author: "user",
      payload: {
        campaignId: "campaign",
        name: "AXON",
        account: cycle.account,
        currency: cycle.currency,
        underlyingKey: cycle.underlyingKey,
      },
    },
    decisionWatermark(store),
  );
  await appendDecision(
    store,
    {
      kind: "wheel_campaign_membership",
      clientRequestId: "member",
      author: "user",
      payload: { lifecycleId: cycle.id, campaignId: "campaign" },
    },
    decisionWatermark(store),
  );
  await rebuild(store, {
    mode: "projection",
    parserVersion: "flex-v1",
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
  const app = Fastify();
  await registerLifecycleRoutes(app, store);
  try {
    const list = await toolJson(tools, "list_campaigns", {
      account: cycle.account,
      currency: "USD",
    });
    expect(list.total).toBe(1);
    const result = await toolJson(tools, "get_campaign", {
      campaignId: "campaign",
    });
    const route = (await app.inject("/api/campaigns/campaign")).json();
    expect(result.summary).toEqual(route.summary);
    expect(result.items).toHaveLength(1);
    expect(result.summary.completed).toBe(1);
    expect(result.summary.broker.pnl.value).toBe("-451.660745");
    expect(
      await callTool(tools, "get_campaign", { campaignId: "unknown" }),
    ).toMatchObject({ isError: true });
  } finally {
    await app.close();
  }
});

it("legacy_build_requires_rebuild instead of empty success", async () => {
  const t = await analyticsApp();
  try {
    t.store.db.prepare("DELETE FROM lifecycle_projection_views").run();
    const tools = createChatTools(toolContext(t.store));
    for (const [name, input] of [
      ["list_lifecycles", {}],
      ["list_campaigns", {}],
      ["get_lifecycle", { lifecycleId: "old" }],
      ["get_campaign", { campaignId: "old" }],
    ] as const) {
      const result = await callTool(tools, name, input);
      expect(result.isError).toBe(true);
      expect(result.content).toContain("LIFECYCLE_REBUILD_REQUIRED");
    }
  } finally {
    await t.close();
  }
});

it("large_members_are_fully_pageable and account filters separate same-symbol lifecycles", async () => {
  const bytes = buildExecutionTable(
    Array.from({ length: 72 }, (_, i) =>
      executionRow({
        ClientAccountID: i === 71 ? "OTHER" : "A",
        AssetClass: "STK",
        Symbol: "XYZ",
        UnderlyingSymbol: "XYZ",
        Conid: "100",
        CurrencyPrimary: "USD",
        TradeDate: "2026-10-01",
        DateTime: "2026-10-01 12:00:00",
        Quantity: "1",
        TradePrice: "100",
        NetCash: "-100",
        Multiplier: "1",
        "Notes/Codes": "O",
        IBExecID: `exec-${i}`,
        IBOrderID: i === 71 ? "other" : "one-order",
      }),
    ),
  );
  const { tools } = await setup(bytes);
  const list = await toolJson(tools, "list_lifecycles", {
    account: "A",
    underlying: "XYZ",
  });
  expect(list.total).toBe(1);
  const first = await toolJson(tools, "get_lifecycle", {
    lifecycleId: list.items[0].id,
    limit: 50,
  });
  expect(first.total).toBe(71);
  const ids: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await toolJson(tools, "get_lifecycle", {
      lifecycleId: list.items[0].id,
      offset,
      limit: 30,
    });
    ids.push(
      ...page.items.map(
        (m: { allocation: { executionKey: string } }) =>
          m.allocation.executionKey,
      ),
    );
    offset = page.nextOffset;
  }
  expect(ids).toHaveLength(71);
  expect(new Set(ids).size).toBe(71);
  expect(
    (await toolJson(tools, "list_lifecycles", { account: "OTHER" })).total,
  ).toBe(1);
});

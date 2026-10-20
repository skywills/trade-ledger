import { afterEach, expect, it } from "vitest";
import { aggregateAnalytics } from "../../src/server/analytics/aggregate.js";
import { parseAnalyticsQuery } from "../../src/server/analytics/query.js";
import { readAnalyticsSnapshot } from "../../src/server/analytics/snapshot.js";
import { createChatTools } from "../../src/server/chat/tools/index.js";
import { analyticsApp } from "../helpers/analytics-app.js";
import { seedLedger } from "../helpers/chat.js";
import { callTool, toolContext, toolJson } from "../helpers/chat-tools.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});
async function setup() {
  const t = await createTestStore();
  stores.push(t);
  await seedLedger(t.store);
  const ctx = toolContext(t.store);
  return { ...t, ctx, tools: createChatTools(ctx) };
}

it("summary_equals_dashboard_for_both_units_and_bases", async () => {
  const { store, ctx, tools } = await setup();
  for (const unit of ["strategy", "lifecycle"])
    for (const basis of ["broker", "reconstructed"]) {
      const dashboard = aggregateAnalytics(
        readAnalyticsSnapshot(store, ctx.now()),
        parseAnalyticsQuery({ unit, basis }),
      );
      const summary = await toolJson(tools, "get_analytics_summary", {
        unit,
        basis,
      });
      expect(summary.performance).toEqual(dashboard.performance);
      expect(summary.transactions).toEqual(dashboard.transactions);
      expect(summary.filters).toEqual(dashboard.filters);
      expect(summary.drawdownBasis).toBe("closed_pnl");
      expect(summary).not.toHaveProperty("daily");
      expect(summary.performance.pnl).toBe(
        basis === "broker" ? "-451.660745" : "-451.6607454",
      );
    }
});

it("selects_dashboard_default_currency_without_combining and does_not_fallback_from_missing_broker", async () => {
  const { store, tools } = await setup();
  store.db
    .prepare("UPDATE strategy_views SET currency = 'EUR', broker_pnl = NULL")
    .run();
  const summary = await toolJson(tools, "get_analytics_summary", {
    unit: "strategy",
  });
  expect(summary.filters.currency).toBe("EUR");
  expect(summary.performance).toMatchObject({ pnl: null, missing: 1 });
  expect(
    (
      await toolJson(tools, "get_analytics_summary", {
        unit: "strategy",
        currency: "USD",
      })
    ).performance.closed,
  ).toBe(0);
});

it("details_support_arbitrary_offset and large_details_resume_at_actual_offset", async () => {
  const t = await analyticsApp();
  try {
    const tools = createChatTools(toolContext(t.store));
    const page = await toolJson(tools, "get_analytics_details", {
      unit: "strategy",
      kind: "strategies",
      offset: 47,
      limit: 10,
    });
    expect(page.total).toBe(679);
    const all = await toolJson(tools, "get_analytics_details", {
      unit: "strategy",
      kind: "strategies",
      offset: 0,
      limit: 50,
    });
    expect(page.items.slice(0, 3)).toEqual(all.items.slice(47, 50));
    expect(page.items).toHaveLength(10);
    expect(page.nextOffset).toBe(57);
    t.store.db
      .prepare("UPDATE strategy_views SET description = ?")
      .run("x".repeat(1500));
    const large = await toolJson(tools, "get_analytics_details", {
      unit: "strategy",
      kind: "strategies",
      offset: 40,
      limit: 50,
    });
    expect(large.items.length).toBeGreaterThan(0);
    expect(large.items.length).toBeLessThan(50);
    expect(large.nextOffset).toBe(40 + large.items.length);
    const next = await toolJson(tools, "get_analytics_details", {
      unit: "strategy",
      kind: "strategies",
      offset: large.nextOffset,
      limit: 1,
    });
    expect(next.items[0].id).not.toBe(large.items.at(-1).id);
  } finally {
    await t.close();
  }
});

it("breakdowns_reassemble_full_service_series", async () => {
  const { store, ctx, tools } = await setup();
  const dashboard = aggregateAnalytics(
    readAnalyticsSnapshot(store, ctx.now()),
    parseAnalyticsQuery({}),
  );
  for (const section of [
    "daily",
    "monthly",
    "byStrategyType",
    "byUnderlying",
    "recent",
    "best",
    "worst",
  ] as const) {
    const result = await toolJson(tools, "get_analytics_breakdown", {
      section,
    });
    expect(result.items).toEqual(dashboard[section]);
    expect(result.total).toBe(dashboard[section].length);
  }
});

it("rejects_invalid_dates_unknown_fields_and_changed_builds", async () => {
  const { tools } = await setup();
  for (const [name, required] of [
    ["get_analytics_summary", {}],
    ["get_analytics_details", { kind: "strategies" }],
    ["get_analytics_breakdown", { section: "daily" }],
  ] as const) {
    for (const invalid of [
      { from: "2026-02-30" },
      { from: "2026-10-20", to: "2026-01-01" },
      { unexpected: true },
      { expectedBuildId: "old" },
    ]) {
      expect(
        await callTool(tools, name, { ...required, ...invalid }),
      ).toMatchObject({ isError: true });
    }
  }
});

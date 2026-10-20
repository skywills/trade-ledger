import { afterEach, expect, it } from "vitest";
import { journalTools } from "../../src/server/chat/tools/journal.js";
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
  const ctx = toolContext(t.store);
  return { ...t, ctx, tools: journalTools(ctx) };
}

it("rejects_old_build_after_activation for every journal read", async () => {
  const { store, tools } = await setup();
  const first = await seedLedger(store);
  const strategies = await toolJson(tools, "list_strategies");
  await seedLedger(store);
  for (const [name, extra] of [
    ["list_strategies", {}],
    ["list_transactions", {}],
    ["list_review_issues", {}],
    ["get_strategy", { strategyId: strategies.items[0].id }],
  ] as const) {
    const result = await callTool(tools, name, {
      ...extra,
      expectedBuildId: first.buildId,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ANALYTICS_BUILD_CHANGED");
  }
});

it("preserves_null_build_metadata and legacy journal calls", async () => {
  const { tools } = await setup();
  for (const name of [
    "list_strategies",
    "list_transactions",
    "list_review_issues",
  ]) {
    expect(await toolJson(tools, name)).toMatchObject({
      buildId: null,
      ledgerId: null,
      stale: false,
      items: [],
      nextOffset: null,
    });
  }
});

it("rejects invalid calendar dates and inverted ranges", async () => {
  const { tools } = await setup();
  for (const name of ["list_strategies", "list_transactions"]) {
    for (const input of [
      { from: "2026-02-30" },
      { from: "2026-10-20", to: "2026-10-01" },
    ]) {
      expect(await callTool(tools, name, input)).toMatchObject({
        isError: true,
      });
    }
  }
});

it("shortened_window_continues_without_skip and preserves global totals", async () => {
  const { pageSelectedResult } = await import(
    "../../src/server/chat/tools/snapshot.js"
  );
  const rows = Array.from({ length: 160 }, (_, id) => ({
    id,
    blob: "x".repeat(1500),
  }));
  const returned: number[] = [];
  let offset: number | null = 47;
  while (offset !== null) {
    const result = pageSelectedResult(
      {},
      rows.slice(offset, offset + 50),
      rows.length,
      offset,
      50,
    );
    expect(result.isError).toBeUndefined();
    const page = JSON.parse(result.content);
    expect(page.total).toBe(160);
    returned.push(...page.items.map((row: { id: number }) => row.id));
    offset = page.nextOffset;
  }
  expect(returned).toEqual(Array.from({ length: 113 }, (_, i) => i + 47));
  expect(
    JSON.parse(pageSelectedResult({}, [], 160, 200, 50).content),
  ).toMatchObject({ items: [], total: 160, nextOffset: null });
});

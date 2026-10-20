import { afterEach, expect, it } from "vitest";
import { createChatTools } from "../../src/server/chat/tools/index.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import { callTool, toolContext, toolJson } from "../helpers/chat-tools.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});
async function setup() {
  const t = await createTestStore();
  stores.push(t);
  return { ...t, tools: createChatTools(toolContext(t.store)) };
}

it("returns_empty_history_without_build", async () => {
  const { tools } = await setup();
  expect(await toolJson(tools, "get_decision_history")).toMatchObject({
    buildId: null,
    ledgerId: null,
    watermark: 0,
    items: [],
    total: 0,
    nextOffset: null,
  });
});

it("superseded_status_survives_page_and_filter_boundaries and rejects_changed_watermark", async () => {
  const { store, tools } = await setup();
  const prior = await appendDecision(
    store,
    {
      kind: "notes",
      clientRequestId: "first",
      author: "user",
      payload: { strategyId: "s-1", text: "old" },
    },
    0,
  );
  const replacement = await appendDecision(
    store,
    {
      kind: "notes",
      clientRequestId: "second",
      author: "user",
      supersedesId: prior.id,
      payload: { strategyId: "s-1", text: "new" },
    },
    1,
  );
  const page = await toolJson(tools, "get_decision_history", {
    kind: "notes",
    strategyId: "s-1",
    offset: 1,
    limit: 1,
    expectedWatermark: 2,
  });
  expect(page.items).toEqual([
    expect.objectContaining({
      id: prior.id,
      effective: false,
      supersededBy: replacement.id,
    }),
  ]);
  expect(page.total).toBe(2);
  expect(page.nextOffset).toBeNull();
  expect(
    (await toolJson(tools, "get_decision_history", { limit: 1 })).items[0],
  ).toMatchObject({ id: replacement.id, effective: true, supersededBy: null });
  expect(
    await callTool(tools, "get_decision_history", { expectedWatermark: 1 }),
  ).toMatchObject({ isError: true });
});

it("history_matches_exact_payload_references and filters_do_not_match_substrings", async () => {
  const { store, tools } = await setup();
  const entries = [
    {
      kind: "notes",
      payload: {
        strategyId: "s-10",
        text: "s-1 lifecycle-1 campaign-1 import-1",
      },
    },
    {
      kind: "group_merge",
      payload: { chosenStrategyId: "s-1", mergedStrategyIds: ["s-2"] },
    },
    {
      kind: "lifecycle_attachment",
      payload: {
        opening: { strategyId: "s-3", executionKey: "e", role: "open" },
        targets: [{ lifecycleId: "lifecycle-1", quantity: "-1" }],
      },
    },
    {
      kind: "wheel_campaign_membership",
      payload: { lifecycleId: "lifecycle-1", campaignId: "campaign-1" },
    },
    { kind: "import_exclusion", payload: { importId: "import-1" } },
  ];
  // Retained-history fixture: records exercise reference lookup independently of
  // current build membership (old decisions can refer to retired entities).
  const insert = store.db.prepare(
    "INSERT INTO decisions(id,sequence,kind,source_refs_json,strategy_ids_json,payload_json,supersedes_id,client_request_id,author,created_at) VALUES(?,?,?,'[]','[]',?,NULL,?,'user','2026-10-20')",
  );
  entries.forEach((d, i) => {
    insert.run(`d-${i}`, i + 1, d.kind, JSON.stringify(d.payload), `r-${i}`);
  });
  for (const [query, ids] of [
    [{ strategyId: "s-1" }, ["d-1"]],
    [{ strategyId: "s-3" }, ["d-2"]],
    [{ lifecycleId: "lifecycle-1" }, ["d-3", "d-2"]],
    [{ lifecycleId: "lifecycle-1", campaignId: "campaign-1" }, ["d-3"]],
    [{ importId: "import-1" }, ["d-4"]],
    [{ strategyId: "s" }, []],
  ] as const) {
    expect(
      (await toolJson(tools, "get_decision_history", query)).items.map(
        (d: { id: string }) => d.id,
      ),
    ).toEqual(ids);
  }
  expect(decisionWatermark(store)).toBe(5);
});

it("shortened history pages preserve global total and actual continuation", async () => {
  const { store, tools } = await setup();
  for (let i = 0; i < 50; i++)
    await appendDecision(
      store,
      {
        kind: "notes",
        clientRequestId: `note-${i}`,
        author: "user",
        payload: { strategyId: "s", text: "x".repeat(1500) },
      },
      i,
    );
  const page = await toolJson(tools, "get_decision_history", { limit: 50 });
  expect(page.total).toBe(50);
  expect(page.items.length).toBeLessThan(50);
  expect(page.nextOffset).toBe(page.items.length);
});

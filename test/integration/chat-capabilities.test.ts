import { afterEach, expect, it } from "vitest";
import { PROPOSAL_KINDS } from "../../src/server/ai/proposals.js";
import { createChatTools } from "../../src/server/chat/tools/index.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
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
  return { ...t, ctx, tools: createChatTools(ctx) };
}

it("capabilities_match_registered_tools_and_proposals and reflect guard behavior", async () => {
  const { store, tools } = await setup();
  const result = await toolJson(tools, "get_capabilities");
  expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
    tools.map((t) => t.name).sort(),
  );
  expect(result.proposalKinds).toEqual(PROPOSAL_KINDS);
  expect(
    result.tools.find((t: { name: string }) => t.name === "commit_import")
      .approval,
  ).toBe("always");
  expect(
    result.tools.find(
      (t: { name: string }) => t.name === "get_analytics_summary",
    ).approval,
  ).toBe("never");
  expect(result).toMatchObject({
    buildId: null,
    ledgerId: null,
    limits: {
      maxListRows: 50,
      maxProposalsPerTurn: 20,
      maxReadCallsPerTool: 30,
      maxIdenticalReadCalls: 2,
    },
  });
  expect(result.unsupported).toContain("live_quotes");
  expect(result.unsupported).toContain("multiplier_corrections");
  expect(result.analytics).toEqual({
    units: ["lifecycle", "strategy"],
    bases: ["broker", "reconstructed"],
    defaultUnit: "lifecycle",
    defaultBasis: "broker",
  });
  expect(await callTool(tools, "get_capabilities")).not.toMatchObject({
    isError: true,
  });
  expect(await callTool(tools, "get_capabilities")).toMatchObject({
    isError: true,
  });
  await seedLedger(store);
  const freshTools = createChatTools(toolContext(store));
  const populated = await toolJson(freshTools, "get_capabilities");
  expect(populated.buildId).toBeTypeOf("string");
  expect(populated.ledgerId).toBeTypeOf("string");
});

it("underlying_filter_includes_options_and_stock and filters_intersect_by_account_and_instrument", async () => {
  const { store, tools } = await setup();
  const rows = [
    { account: "A", asset: "STK", symbol: "XYZ", conid: "1" },
    { account: "A", asset: "OPT", symbol: "XYZ CALL", conid: "2" },
    { account: "B", asset: "STK", symbol: "XYZ", conid: "1" },
    { account: "A", asset: "STK", symbol: "OTHER", conid: "3" },
  ];
  await seedLedger(
    store,
    buildExecutionTable(
      rows.map((r, i) =>
        executionRow({
          ClientAccountID: r.account,
          AssetClass: r.asset,
          Symbol: r.symbol,
          UnderlyingSymbol: r.symbol === "OTHER" ? "OTHER" : "XYZ",
          Conid: r.conid,
          CurrencyPrimary: "USD",
          TradeDate: "2026-10-01",
          DateTime: "2026-10-01 12:00:00",
          Quantity: r.asset === "OPT" ? "-1" : "100",
          TradePrice: "1",
          NetCash: r.asset === "OPT" ? "100" : "-100",
          Multiplier: r.asset === "OPT" ? "100" : "1",
          Expiry: r.asset === "OPT" ? "2026-11-20" : "",
          Strike: r.asset === "OPT" ? "105" : "",
          "Put/Call": r.asset === "OPT" ? "C" : "",
          "Notes/Codes": "O",
          IBExecID: `e-${i}`,
          IBOrderID: `o-${i}`,
        }),
      ),
    ),
  );
  const underlying = await toolJson(tools, "list_transactions", {
    underlying: "xyz",
  });
  expect(underlying.total).toBe(3);
  const selected = await toolJson(tools, "list_transactions", {
    underlying: "XYZ",
    account: "A",
    assetClass: "STK",
    instrumentKey: "conid:1",
  });
  expect(selected.total).toBe(1);
  expect(selected.items[0].symbol).toBe("XYZ");
  expect(
    (
      await toolJson(tools, "list_transactions", {
        executionKey: selected.items[0].key,
        account: "B",
      })
    ).total,
  ).toBe(0);
  const strategies = await toolJson(tools, "list_strategies", {
    underlying: "XYZ",
    account: "A",
    assetClass: "OPT",
  });
  expect(strategies.total).toBe(1);
  expect(
    (await toolJson(tools, "list_strategies", { symbol: "OTHER" })).total,
  ).toBe(1);
});

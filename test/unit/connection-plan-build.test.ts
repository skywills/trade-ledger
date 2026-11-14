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
import { LifecycleListSchema } from "../../src/web/lifecycles/api.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

const provenance = {
  buildId: null,
  ledgerId: null,
  stale: false,
  generatedAt: "2026-11-13T00:00:00Z",
  watermark: 0,
  rebuildRequired: false,
};
const ref = { strategyId: "s", executionKey: "k", role: "open" };

function listWith(suggestion: Record<string, unknown>) {
  return {
    ...provenance,
    lifecycles: {
      version: 1,
      lifecycles: [],
      members: [],
      campaigns: [],
      suggestions: [suggestion],
      issues: [],
      valuations: [],
    },
  };
}

const base = {
  id: "x",
  callOpening: ref,
  candidateLifecycleIds: ["l"],
  quantity: "-1",
  sources: [],
  reasons: [],
};

it("parses suggestions with and without a plan", () => {
  const without = LifecycleListSchema.parse(listWith(base));
  expect(without.lifecycles?.suggestions[0]?.plan).toBeUndefined();
  const withPlan = LifecycleListSchema.parse(
    listWith({
      ...base,
      plan: {
        action: "connect",
        lifecycleId: "l",
        reason: "COVERED",
        sharesAtOpening: "100",
        dependsOn: [ref],
      },
    }),
  );
  expect(withPlan.lifecycles?.suggestions[0]?.plan).toMatchObject({
    action: "connect",
    sharesAtOpening: "100",
  });
  expect(() =>
    LifecycleListSchema.parse(
      listWith({ ...base, plan: { action: "bogus", lifecycleId: null } }),
    ),
  ).toThrow();
});

it("carries a plan on built suggestions", async () => {
  const t = await createTestStore();
  try {
    const preview = await previewImport(t.store, {
      filename: "covered-call.csv",
      timezone: "UTC",
      bytes: buildExecutionTable([
        executionRow({
          ClientAccountID: "A",
          AssetClass: "STK",
          Symbol: "XYZ",
          Conid: "1",
          CurrencyPrimary: "USD",
          TradeDate: "2026-10-01",
          DateTime: "2026-10-01 12:00:00",
          Quantity: "100",
          TradePrice: "100",
          NetCash: "-10000",
          Multiplier: "1",
          "Notes/Codes": "O",
          IBExecID: "stock-open",
          IBOrderID: "stock-order",
        }),
        executionRow({
          ClientAccountID: "A",
          AssetClass: "OPT",
          Symbol: "XYZ CALL",
          UnderlyingSymbol: "XYZ",
          Conid: "2",
          CurrencyPrimary: "USD",
          TradeDate: "2026-10-03",
          DateTime: "2026-10-03 12:00:00",
          Quantity: "-1",
          TradePrice: "1",
          NetCash: "100",
          Multiplier: "100",
          Expiry: "2026-11-20",
          Strike: "105",
          "Put/Call": "C",
          "Notes/Codes": "O",
          IBExecID: "call-open",
          IBOrderID: "call-order",
        }),
      ]),
    });
    await commitImport(t.store, preview.id);
    await rebuild(t.store, {
      mode: "full",
      parserVersion: "flex-v1",
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    const suggestions =
      activeProjection(t.store).projection?.lifecycles?.suggestions ?? [];
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.plan).toMatchObject({
      action: "connect",
      reason: "COVERED",
      sharesAtOpening: "100",
    });
  } finally {
    await t.dispose();
  }
});

it("labels this algorithm version lifecycles-v13", () => {
  expect(ALGORITHM_VERSION).toBe("lifecycles-v13");
});

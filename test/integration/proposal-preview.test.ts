import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  parseProposal,
  proposalDecisionInput,
} from "../../src/server/ai/proposals.js";
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
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import { fixtures } from "../fixtures/scenarios.js";
import { seedLedger } from "../helpers/chat.js";
import { toolContext, toolJson } from "../helpers/chat-tools.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});
async function setup(bytes: Uint8Array = fixtures.spread) {
  const t = await createTestStore();
  stores.push(t);
  const { buildId, ledger } = await seedLedger(t.store, bytes);
  const root = join(t.dataDir, "preview-temp");
  await mkdir(root);
  vi.stubEnv("TMPDIR", root);
  const strategyId = activeProjection(t.store).projection?.strategies[0]?.id;
  if (!strategyId) throw new Error("No strategy");
  return {
    ...t,
    root,
    ledger,
    strategyId,
    expected: { buildId, watermark: 0 },
    proposal: parseProposal({
      kind: "notes",
      payload: { strategyId, text: "Preview only" },
    }),
  };
}
function tables(store: Store) {
  const names = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    names.map(({ name }) => [
      name,
      store.db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
    ]),
  );
}

it("preview_valid_notes_changes_no_live_tables and full_rebuild_impacts_match_separate_test_store", async () => {
  const { previewProposal } = await import(
    "../../src/server/ai/proposal-preview.js"
  );
  const { store, root, proposal, expected } = await setup();
  const before = tables(store);
  const result = await previewProposal(store, proposal, expected);
  expect(result).toMatchObject({
    valid: true,
    buildId: expected.buildId,
    watermark: 0,
  });
  expect(result.impact?.before.pnlByCurrency).toEqual([
    {
      currency: "USD",
      brokerPnl: "-451.660745",
      reconstructedPnl: "-451.6607454",
      missingBrokerPnl: 0,
      missingReconstructedPnl: 0,
    },
  ]);
  expect(result.impact?.after).toEqual(result.impact?.before);
  expect(tables(store)).toEqual(before);
  expect(await readdir(root)).toEqual([]);
  const elapsed = performance.now();
  const tool = await toolJson(
    createChatTools(toolContext(store)),
    "preview_proposal",
    { proposal, expectedBuildId: expected.buildId, expectedWatermark: 0 },
  );
  expect(tool.valid).toBe(true);
  expect(performance.now() - elapsed).toBeGreaterThan(0);
});

it("over_allocation_is_invalid_without_impact", async () => {
  const { previewProposal } = await import(
    "../../src/server/ai/proposal-preview.js"
  );
  const { store, root, ledger, strategyId, expected } = await setup();
  const execution = ledger.executions[0];
  if (!execution) throw new Error("No execution");
  const proposal = parseProposal({
    kind: "manual_allocation",
    payload: {
      strategyId,
      source: execution.sources[0],
      allocations: [
        { executionKey: execution.key, quantity: "1000000", netCash: "0" },
      ],
    },
  });
  const result = await previewProposal(store, proposal, expected);
  expect(result).toMatchObject({ valid: false, impact: null });
  expect(result.issues).toContainEqual({
    code: "OVER_ALLOCATION",
    severity: "error",
  });
  expect(await readdir(root)).toEqual([]);
  expect(decisionWatermark(store)).toBe(0);
});

it("stale_or_missing_build_requires_rebuild", async () => {
  const { previewProposal } = await import(
    "../../src/server/ai/proposal-preview.js"
  );
  const { store, proposal, expected } = await setup();
  await appendDecision(
    store,
    { ...proposalDecisionInput(proposal), clientRequestId: "unrelated" },
    0,
  );
  await expect(
    previewProposal(store, proposal, expected),
  ).rejects.toMatchObject({ code: "STALE_INPUT" });
  const empty = await createTestStore();
  stores.push(empty);
  await expect(
    previewProposal(empty.store, proposal, { buildId: "none", watermark: 0 }),
  ).rejects.toMatchObject({ code: "NO_ACTIVE_BUILD" });
});

it.each(["decision", "import", "activation"])(
  "concurrent %s change discards the simulated result",
  async (kind) => {
    const { previewProposal } = await import(
      "../../src/server/ai/proposal-preview.js"
    );
    const { store, proposal, expected, root } = await setup();
    const actual = store.db.backup.bind(store.db);
    vi.spyOn(store.db, "backup").mockImplementation(
      async (destination, options) => {
        const result = await actual(destination, options);
        if (kind === "decision")
          await appendDecision(store, proposalDecisionInput(proposal), 0);
        if (kind === "import") {
          const p = await previewImport(store, {
            filename: "later.csv",
            bytes: fixtures.partialFills,
            timezone: "UTC",
          });
          await commitImport(store, p.id);
        }
        if (kind === "activation")
          await rebuild(store, {
            mode: "projection",
            parserVersion: "flex-v1",
            algorithmVersion: ALGORITHM_VERSION,
            signal: new AbortController().signal,
          });
        return result;
      },
    );
    await expect(
      previewProposal(store, proposal, expected),
    ).rejects.toMatchObject({
      code: kind === "activation" ? "ANALYTICS_BUILD_CHANGED" : "STALE_INPUT",
    });
    expect(await readdir(root)).toEqual([]);
  },
);

it("cleanup_after_failure_or_abort", async () => {
  const { previewProposal } = await import(
    "../../src/server/ai/proposal-preview.js"
  );
  const { store, proposal, expected, root } = await setup();
  const actual = store.db.backup.bind(store.db);
  vi.spyOn(store.db, "backup").mockImplementation(async (dest, options) => {
    await actual(dest, options);
    throw new Error("disk failure");
  });
  await expect(previewProposal(store, proposal, expected)).rejects.toThrow(
    "disk failure",
  );
  expect(await readdir(root)).toEqual([]);
  vi.restoreAllMocks();
  const controller = new AbortController();
  vi.spyOn(store.db, "backup").mockImplementation(async (dest, options) => {
    const result = await actual(dest, options);
    controller.abort();
    return result;
  });
  await expect(
    previewProposal(store, proposal, expected, { signal: controller.signal }),
  ).rejects.toMatchObject({ code: "PROPOSAL_PREVIEW_CANCELLED" });
  expect(await readdir(root)).toEqual([]);
  expect(decisionWatermark(store)).toBe(0);
});

it("preview tool honors a cancelled turn", async () => {
  const { store, proposal, expected, root } = await setup();
  const tool = createChatTools(toolContext(store)).find(
    (t) => t.name === "preview_proposal",
  );
  expect(tool).toBeDefined();
  const controller = new AbortController();
  controller.abort();
  const result = await tool?.run(
    { proposal, expectedBuildId: expected.buildId, expectedWatermark: 0 },
    { sessionId: "s", toolCallId: "c", signal: controller.signal },
  );
  expect(result).toMatchObject({ isError: true });
  expect(await readdir(root)).toEqual([]);
});

it("unknown_pnl_stays_null_per_currency", async () => {
  const { previewProposal } = await import(
    "../../src/server/ai/proposal-preview.js"
  );
  const { store, proposal, expected } = await setup(fixtures.partialFills);
  const result = await previewProposal(store, proposal, expected);
  expect(result.valid).toBe(true);
  expect(result.impact?.before.pnlByCurrency).toEqual([
    expect.objectContaining({
      currency: "USD",
      brokerPnl: null,
      missingBrokerPnl: 1,
    }),
  ]);
  expect(result.impact?.after.pnlByCurrency).toEqual(
    result.impact?.before.pnlByCurrency,
  );
});

it("changes after simulation finishes invalidate the result", async () => {
  const service = await import("../../src/server/builds/service.js");
  const { previewProposal } = await import(
    "../../src/server/ai/proposal-preview.js"
  );
  const { store, proposal, expected, root } = await setup();
  const actual = service.rebuild;
  vi.spyOn(service, "rebuild").mockImplementation(async (...args) => {
    const result = await actual(...args);
    await appendDecision(store, proposalDecisionInput(proposal), 0);
    return result;
  });
  await expect(
    previewProposal(store, proposal, expected),
  ).rejects.toMatchObject({ code: "STALE_INPUT" });
  expect(await readdir(root)).toEqual([]);
});

it("blocks a later connection in preview and direct saves, then unlocks it after reviewing the earlier call", async () => {
  const { buildExecutionTable, executionRow } = await import(
    "../fixtures/scenarios.js"
  );
  const { connectionGroups, connectionProposal } = await import(
    "../../src/web/lifecycles/connections.js"
  );
  const { previewProposal } = await import(
    "../../src/server/ai/proposal-preview.js"
  );
  const bytes = buildExecutionTable(
    (
      [
        ["shares", "STK", "1", "100", "-10000", "O", "1"],
        ["early", "OPT", "2", "-1", "100", "O", "2"],
        ["early-close", "OPT", "3", "1", "-50", "C", "2"],
        ["late", "OPT", "4", "-1", "100", "O", "3"],
      ] as const
    ).map(([id, asset, day, quantity, cash, action, conid]) =>
      executionRow({
        ClientAccountID: "A",
        CurrencyPrimary: "USD",
        AssetClass: asset,
        Symbol: asset === "OPT" ? `XYZ CALL ${conid}` : "XYZ",
        UnderlyingSymbol: "XYZ",
        Conid: conid,
        TradeDate: `2024-06-0${day}`,
        DateTime: `2024-06-0${day} 12:00:00`,
        Quantity: quantity,
        NetCash: cash,
        IBExecID: id,
        IBOrderID: id,
        "Notes/Codes": action,
        Multiplier: asset === "OPT" ? "100" : "1",
        Expiry: asset === "OPT" ? "2024-06-21" : "",
        Strike: asset === "OPT" ? (conid === "2" ? "105" : "110") : "",
        "Put/Call": asset === "OPT" ? "C" : "",
      }),
    ),
  );
  const { store, ledger, expected } = await setup(bytes);
  const p = activeProjection(store).projection?.lifecycles;
  if (!p) throw new Error("Missing lifecycle projection");
  const [early, late] = connectionGroups(
    p.suggestions,
    p.members,
    ledger.executions,
  );
  const target = late?.candidateIds[0];
  if (!early || !late || !target) throw new Error("Missing connections");
  const proposal = parseProposal(connectionProposal(late, target));
  const blocked = await previewProposal(store, proposal, expected);
  expect(blocked).toMatchObject({
    valid: false,
    impact: null,
    issues: [{ code: "EARLIER_CONNECTION_UNRESOLVED", severity: "error" }],
    blockingConnection: {
      date: "2024-06-02",
      lifecycleId: early.members[0]?.lifecycleId,
    },
  });
  await expect(
    appendDecision(store, proposalDecisionInput(proposal), 0),
  ).rejects.toMatchObject({
    code: "EARLIER_CONNECTION_UNRESOLVED",
    statusCode: 409,
  });
  expect(decisionWatermark(store)).toBe(0);
  await appendDecision(
    store,
    proposalDecisionInput(parseProposal(connectionProposal(early, "", true))),
    0,
  );
  await rebuild(store, {
    mode: "full",
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
  const buildId = activeProjection(store).buildId;
  if (!buildId) throw new Error("Missing rebuilt projection");
  expect(
    (await previewProposal(store, proposal, { buildId, watermark: 1 })).valid,
  ).toBe(true);
});

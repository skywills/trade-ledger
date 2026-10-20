import type { EmbedderTool } from "@nathapp/nax-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeProjection,
  BuildScheduler,
} from "../../src/server/builds/service.js";
import { createChatTools } from "../../src/server/chat/tools/index.js";
import type { ChatToolContext } from "../../src/server/chat/tools/shared.js";
import { JobService } from "../../src/server/jobs/service.js";
import { buildExecutionTable, executionRow } from "../fixtures/scenarios.js";
import { seedLedger } from "../helpers/chat.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
});
async function setup() {
  const test = await createTestStore();
  stores.push(test);
  await seedLedger(
    test.store,
    buildExecutionTable([
      executionRow({
        ClientAccountID: "SIM-PRIVATE-ACCOUNT",
        AssetClass: "STK",
        Symbol: "PRIVATE-SYMBOL",
        CurrencyPrimary: "USD",
        Conid: "fictional-contract",
        DateTime: "2026-08-12 11:22:33",
        TradeDate: "2026-08-12",
        Quantity: "-7",
        NetCash: "234.56789",
        CostBasis: "-200.12345",
        FifoPnlRealized: "34.44444",
        "Notes/Codes": "C",
        IBExecID: "private-execution",
      }),
    ]),
  );
  const jobs = new JobService(test.store);
  const ctx: ChatToolContext = {
    store: test.store,
    jobs,
    scheduler: new BuildScheduler(test.store, {}, jobs),
    thread: () => {
      throw new Error("no thread needed");
    },
    turn: {
      current: { turnId: "turn", proposalRunId: null, proposalCount: 0 },
    },
    emitProposal: () => undefined,
    now: () => new Date("2026-10-19T00:00:00Z"),
  };
  const active = activeProjection(test.store);
  const issue = active.projection?.issues.find(
    (issue) => issue.code === "MISSING_OPENING",
  );
  if (!issue || !active.buildId) throw new Error("missing seeded issue");
  return { test, tools: createChatTools(ctx), issue, buildId: active.buildId };
}
async function call(tools: EmbedderTool[], name: string, input: unknown) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.run(input, {
    sessionId: "session",
    toolCallId: "call",
    signal: new AbortController().signal,
  });
}

describe("agent review diagnostics and sanitized reports", () => {
  it("reads source evidence and allocations without writing journal decisions", async () => {
    const { test, tools, issue, buildId } = await setup();
    const before = test.store.db
      .prepare("SELECT count(*) AS n FROM decisions")
      .get();
    const result = await call(tools, "diagnose_review_issue", {
      issueKey: issue.key,
      expectedBuildId: buildId,
    });
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content);
    expect(data).toMatchObject({
      buildId,
      stale: false,
      issue: { code: "MISSING_OPENING" },
      total: 1,
    });
    expect(data.items[0]).toMatchObject({
      symbol: "PRIVATE-SYMBOL",
      action: "close",
      quantity: "-7",
      basis: "-200.12345",
    });
    expect(data.items[0].sources).toEqual(issue.sources);
    expect(data.items[0].allocations.length).toBeGreaterThan(0);
    expect(data.guidance).toContain("submit_proposal");
    expect(
      test.store.db.prepare("SELECT count(*) AS n FROM decisions").get(),
    ).toEqual(before);
  });

  it("generates an allowlisted report without financial data or source identifiers and publishes nothing", async () => {
    const { tools, issue, buildId } = await setup();
    const result = await call(tools, "create_issue_report", {
      issueKey: issue.key,
      expectedBuildId: buildId,
    });
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content);
    expect(data).toMatchObject({
      published: false,
      containsTradingData: false,
    });
    expect(data.report).toContain("MISSING_OPENING");
    expect(data.report).toContain("synthetic");
    for (const privateValue of [
      "PRIVATE-SYMBOL",
      "SIM-PRIVATE-ACCOUNT",
      "234.56789",
      "200.12345",
      "2026-08-12",
      "private-execution",
      issue.key,
      buildId,
      ...issue.sources.map((source) => source.importId),
    ]) {
      expect(result.content).not.toContain(privateValue);
    }
  });

  it("rejects stale build references, unknown issues, and unsupported free-text report fields", async () => {
    const { tools, issue, buildId } = await setup();
    expect(
      await call(tools, "diagnose_review_issue", {
        issueKey: issue.key,
        expectedBuildId: "previous-build",
      }),
    ).toMatchObject({ isError: true });
    expect(
      await call(tools, "diagnose_review_issue", {
        issueKey: "unknown",
        expectedBuildId: buildId,
      }),
    ).toMatchObject({ isError: true });
    expect(
      await call(tools, "create_issue_report", {
        issueKey: issue.key,
        expectedBuildId: buildId,
        notes: "private financial data",
      }),
    ).toMatchObject({ isError: true });
  });
  it("pages time evidence with execution rows for a large scoped finding", async () => {
    const { test, tools } = await setup();
    const rows = Array.from({ length: 260 }, (_, index) =>
      executionRow({
        ClientAccountID: "SIM",
        AssetClass: "STK",
        Symbol: "SYNTHETIC",
        CurrencyPrimary: "USD",
        Conid: "synthetic",
        DateTime: "2026-09-01 12:00:00",
        TradeDate: "2026-09-01",
        Quantity: "-1",
        NetCash: "10",
        "Notes/Codes": "C",
        IBExecID: `synthetic-${index}`,
      }),
    );
    await seedLedger(test.store, buildExecutionTable(rows));
    const active = activeProjection(test.store);
    const missing =
      active.projection?.issues.filter(
        (issue) => issue.code === "MISSING_OPENING",
      ) ?? [];
    const sources = missing.flatMap((issue) => issue.sources);
    const syntheticIssue = "synthetic-large-review";
    test.store.db
      .prepare(
        "INSERT INTO review_items (build_id, stable_issue_key, reason, source_references_json, candidate_json, severity) VALUES (?, ?, ?, ?, '{}', 'warning')",
      )
      .run(
        active.buildId,
        syntheticIssue,
        "PNL_RECONCILIATION",
        JSON.stringify(sources),
      );
    const result = await call(tools, "diagnose_review_issue", {
      issueKey: syntheticIssue,
      expectedBuildId: active.buildId,
      limit: 1,
    });
    expect(result.isError).not.toBe(true);
    const page = JSON.parse(result.content);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(250);
    expect(page.nextOffset).toBe(1);
    expect(page).not.toHaveProperty("timeEvidence");
    expect(page.items[0]).toHaveProperty("openingEvidence");
  });

  it("explains unresolved event cash without suggesting an allocation can supply settlement", async () => {
    const { test, tools, issue, buildId } = await setup();
    const key = "synthetic-event-cash-review";
    test.store.db
      .prepare(
        "INSERT INTO review_items (build_id, stable_issue_key, reason, source_references_json, candidate_json, severity) VALUES (?, ?, 'EVENT_CASH_UNRESOLVED', ?, '{}', 'warning')",
      )
      .run(buildId, key, JSON.stringify(issue.sources));
    const diagnosis = JSON.parse(
      (
        await call(tools, "diagnose_review_issue", {
          issueKey: key,
          expectedBuildId: buildId,
        })
      ).content,
    );
    expect(diagnosis.guidance).toContain("settlement");
    expect(diagnosis.guidance).not.toContain("submit_proposal");
    const report = JSON.parse(
      (
        await call(tools, "create_issue_report", {
          issueKey: key,
          expectedBuildId: buildId,
        })
      ).content,
    );
    expect(report.report).toContain("EVENT_CASH_UNRESOLVED");
    expect(report.report).toContain("settlement");
    expect(report.report).not.toContain("PRIVATE-SYMBOL");
    expect(report.published).toBe(false);
  });

  it("explicitly reports unavailable source diagnosis for a ledger-level finding", async () => {
    const { test, tools, buildId } = await setup();
    const key = "synthetic-ledger-review";
    test.store.db
      .prepare(
        "INSERT INTO review_items (build_id, stable_issue_key, reason, source_references_json, candidate_json, severity) VALUES (?, ?, ?, '[]', '{}', 'warning')",
      )
      .run(buildId, key, "QUARANTINED_EVIDENCE");
    const result = await call(tools, "diagnose_review_issue", {
      issueKey: key,
      expectedBuildId: buildId,
    });
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content);
    expect(data).toMatchObject({
      evidenceStatus: "source_evidence_unavailable",
    });
    expect(data.guidance).toContain("import");
  });
  it("resolves strategy and lifecycle P&L scopes when source references are empty", async () => {
    const { test, tools, buildId } = await setup();
    const active = activeProjection(test.store);
    const strategy = active.projection?.strategies[0];
    const lifecycle = active.projection?.lifecycles?.lifecycles[0];
    if (!strategy || !lifecycle) throw new Error("missing scope fixtures");
    for (const key of [
      `strategy:PNL_RECONCILIATION:${strategy.id}:`,
      `lifecycle:pnl:${lifecycle.id}`,
    ]) {
      test.store.db
        .prepare(
          "INSERT INTO review_items (build_id, stable_issue_key, reason, source_references_json, candidate_json, severity) VALUES (?, ?, 'PNL_RECONCILIATION', '[]', '{}', 'warning')",
        )
        .run(buildId, key);
      const result = await call(tools, "diagnose_review_issue", {
        issueKey: key,
        expectedBuildId: buildId,
      });
      expect(result.isError).not.toBe(true);
      const data = JSON.parse(result.content);
      expect(data.evidenceStatus).toBe("available");
      expect(data.items).toHaveLength(1);
      expect(data.items[0].directlyReferenced).toBe(true);
    }
  });

  it("includes already-consumed opening history without claiming available exposure", async () => {
    const { test, tools } = await setup();
    await seedLedger(
      test.store,
      buildExecutionTable([
        executionRow({
          ClientAccountID: "SIM",
          AssetClass: "STK",
          Symbol: "SYNTHETIC",
          CurrencyPrimary: "USD",
          Conid: "synthetic",
          DateTime: "2026-09-01 12:00:00",
          Quantity: "1",
          NetCash: "-10",
          "Notes/Codes": "O",
          IBExecID: "opening",
        }),
        executionRow({
          ClientAccountID: "SIM",
          AssetClass: "STK",
          Symbol: "SYNTHETIC",
          CurrencyPrimary: "USD",
          Conid: "synthetic",
          DateTime: "2026-09-02 12:00:00",
          Quantity: "-1",
          NetCash: "11",
          "Notes/Codes": "C",
          IBExecID: "first-close",
        }),
        executionRow({
          ClientAccountID: "SIM",
          AssetClass: "STK",
          Symbol: "SYNTHETIC",
          CurrencyPrimary: "USD",
          Conid: "synthetic",
          DateTime: "2026-09-03 12:00:00",
          Quantity: "-1",
          NetCash: "12",
          "Notes/Codes": "C",
          IBExecID: "extra-close",
        }),
      ]),
    );
    const active = activeProjection(test.store);
    const issue = active.projection?.issues.find(
      (issue) =>
        issue.code === "MISSING_OPENING" && issue.key.includes("extra-close"),
    );
    if (!issue) throw new Error("missing extra-close finding");
    const result = await call(tools, "diagnose_review_issue", {
      issueKey: issue.key,
      expectedBuildId: active.buildId,
    });
    expect(result.isError).not.toBe(true);
    const data = JSON.parse(result.content);
    expect(data.items).toHaveLength(3);
    expect(
      data.items.find(
        (row: { directlyReferenced: boolean }) => row.directlyReferenced,
      ).openingEvidence,
    ).toMatchObject({ before: 1 });
    expect(
      data.items.find((row: { action: string }) => row.action === "open")
        .allocations,
    ).toHaveLength(1);
    expect(data.guidance).toContain("does not prove available exposure");
  });

  it("does not copy an unrecognized broker-controlled issue code into a shareable report", async () => {
    const { test, tools, buildId } = await setup();
    const key = "synthetic-private-code";
    test.store.db
      .prepare(
        "INSERT INTO review_items (build_id, stable_issue_key, reason, source_references_json, candidate_json, severity) VALUES (?, ?, ?, '[]', '{}', 'warning')",
      )
      .run(buildId, key, "PRIVATE-SYMBOL 234.56789");
    const result = await call(tools, "create_issue_report", {
      issueKey: key,
      expectedBuildId: buildId,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("OTHER_REVIEW_ISSUE");
    expect(result.content).not.toContain("PRIVATE-SYMBOL");
    expect(result.content).not.toContain("234.56789");
  });
});

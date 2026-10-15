import type { EmbedderTool } from "@nathapp/nax-agent";
import { afterEach, describe, expect, it } from "vitest";
import { BuildScheduler } from "../../src/server/builds/service.js";
import { journalTools } from "../../src/server/chat/tools/journal.js";
import { pnlTools } from "../../src/server/chat/tools/pnl.js";
import type { ChatToolContext } from "../../src/server/chat/tools/shared.js";
import { statusTools } from "../../src/server/chat/tools/status.js";
import { writeTools } from "../../src/server/chat/tools/writes.js";
import {
  commitImport,
  listImports,
  previewImport,
} from "../../src/server/imports/service.js";
import { JobService } from "../../src/server/jobs/service.js";
import type { Store } from "../../src/server/storage/database.js";
import { fixtures } from "../fixtures/scenarios.js";
import { seedLedger } from "../helpers/chat.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const open: TestStore[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
});

function toolContext(store: Store): ChatToolContext {
  const jobs = new JobService(store);
  return {
    store,
    jobs,
    scheduler: new BuildScheduler(store, {}, jobs),
    thread: () => {
      throw new Error("no thread in this test");
    },
    turn: {
      current: { turnId: "turn-1", proposalRunId: null, proposalCount: 0 },
    },
    emitProposal: () => undefined,
    now: () => new Date("2026-10-15T00:00:00Z"),
  };
}

async function call(tools: EmbedderTool[], name: string, input: unknown) {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.run(input, {
    sessionId: "s",
    toolCallId: "c",
    signal: new AbortController().signal,
  });
}

describe("journal read tools", () => {
  it("lists strategies, reads one, lists transactions and review issues", async () => {
    const t = await createTestStore();
    open.push(t);
    await seedLedger(t.store);
    const tools = [
      ...pnlTools(toolContext(t.store)),
      ...journalTools(toolContext(t.store)),
    ];
    const listed = JSON.parse(
      (await call(tools, "list_strategies", { limit: 5 })).content,
    );
    expect(listed.total).toBeGreaterThan(0);
    const id = listed.items[0].id as string;
    const detail = JSON.parse(
      (await call(tools, "get_strategy", { strategyId: id })).content,
    );
    expect(detail.strategy.id).toBe(id);
    const txns = JSON.parse(
      (await call(tools, "list_transactions", {})).content,
    );
    expect(txns.total).toBeGreaterThan(0);
    expect(txns).toHaveProperty("buildId");
    expect(typeof txns.stale).toBe("boolean");
    expect(
      JSON.parse((await call(tools, "list_review_issues", {})).content),
    ).toHaveProperty("items");
    expect(
      JSON.parse((await call(tools, "get_pnl_summary", {})).content).groups
        .length,
    ).toBeGreaterThan(0);
  });

  it("returns isError for bad input and unknown ids, never throws", async () => {
    const t = await createTestStore();
    open.push(t);
    const tools = journalTools(toolContext(t.store));
    expect(
      await call(tools, "get_strategy", { strategyId: "nope" }),
    ).toMatchObject({ isError: true });
    expect(await call(tools, "list_strategies", { limit: 500 })).toMatchObject({
      isError: true,
    });
  });
});

describe("status read tools", () => {
  it("reads imports, a staged preview, build status and a job", async () => {
    const t = await createTestStore();
    open.push(t);
    await seedLedger(t.store);
    const ctx = toolContext(t.store);
    const tools = statusTools(ctx);
    const preview = await previewImport(t.store, {
      filename: "new.csv",
      bytes: fixtures.spread,
      timezone: "UTC",
    });
    const staged = JSON.parse(
      (await call(tools, "get_import_preview", { previewId: preview.id }))
        .content,
    );
    expect(staged).toMatchObject({
      id: preview.id,
      filename: "new.csv",
      committable: true,
    });
    expect(staged.counts.executions).toBeGreaterThan(0);
    await commitImport(t.store, preview.id);
    expect(
      JSON.parse((await call(tools, "list_imports", {})).content).items.length,
    ).toBe(1);
    expect(
      JSON.parse((await call(tools, "get_build_status", {})).content),
    ).toHaveProperty("buildId");
    const jobId = await ctx.jobs.create("backup", {});
    expect(
      JSON.parse((await call(tools, "get_job", { jobId })).content).job.id,
    ).toBe(jobId);
    expect(
      await call(tools, "get_import_preview", { previewId: "missing" }),
    ).toMatchObject({ isError: true });
    expect(await call(tools, "get_job", { jobId: "missing" })).toMatchObject({
      isError: true,
    });
  });
});

describe("write tool descriptions", () => {
  it("asks before every run and describes the import from its preview", async () => {
    const t = await createTestStore();
    open.push(t);
    const tools = writeTools(toolContext(t.store));
    expect(tools.every((tool) => tool.approval === "always")).toBe(true);
    const preview = await previewImport(t.store, {
      filename: "sept.csv",
      bytes: fixtures.spread,
      timezone: "UTC",
    });
    const commit = tools.find((tool) => tool.name === "commit_import");
    expect(commit?.describe?.({ previewId: preview.id })).toMatch(
      /^Commit import "sept\.csv" \(\d+ executions, \d+ quarantined\) and rebuild$/,
    );
    expect(
      tools
        .find((tool) => tool.name === "rebuild")
        ?.describe?.({
          mode: "projection",
        }),
    ).toBe("Rebuild ledger (projection)");
  });
});

describe("commit_import when the rebuild cannot start", () => {
  it("still reports the committed import", async () => {
    const t = await createTestStore();
    open.push(t);
    const ctx = toolContext(t.store);
    const failing: ChatToolContext = {
      ...ctx,
      scheduler: {
        submit: () => Promise.reject(new Error("queue down")),
      } as unknown as ChatToolContext["scheduler"],
    };
    const preview = await previewImport(t.store, {
      filename: "sept.csv",
      bytes: fixtures.spread,
      timezone: "UTC",
    });
    const result = await call(writeTools(failing), "commit_import", {
      previewId: preview.id,
    });
    expect(result.isError).toBeFalsy();
    const text = JSON.stringify(result);
    expect(text).toContain("importId");
    expect(text).toContain("rebuildError");
    expect(text).toContain("queue down");
    expect(listImports(t.store)).toHaveLength(1);
  });
});

describe("tool results fit nax-agent's model-facing limits", () => {
  it("formats results so no line is cut and the JSON stays intact", async () => {
    const { MODEL_MAX_BYTES, MODEL_MAX_LINE_CHARS, MODEL_MAX_LINES } =
      await import("@nathapp/nax-agent");
    const { jsonResult } = await import(
      "../../src/server/chat/tools/shared.js"
    );
    const strategy = (i: number) => ({
      id: `3714f38f-5aba-43f8-85f9-${String(i).padStart(12, "0")}`,
      type: "bull_put_spread",
      currency: "USD",
      description: `Strategy ${i} bull put spread`,
      openingDate: "2026-09-25",
      closeDate: null,
      status: "open",
      brokerPnl: "0",
      reconstructedPnl: null,
      positions: [
        { instrumentKey: "symbol:BA    261120P00180000", quantity: "1" },
        { instrumentKey: "symbol:BA    261120P00190000", quantity: "-1" },
      ],
      reasons: ["MISSING_MULTIPLIER"],
    });
    const payload = {
      buildId: "af42c66d",
      stale: false,
      items: Array.from({ length: 50 }, (_, i) => strategy(i)),
      total: 84,
      nextOffset: 50,
    };
    const result = jsonResult(payload);
    expect(result.isError).toBeUndefined();
    const lines = result.content.split("\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(
      MODEL_MAX_LINE_CHARS,
    );
    expect(lines.length).toBeLessThanOrEqual(MODEL_MAX_LINES);
    expect(Buffer.byteLength(result.content)).toBeLessThan(MODEL_MAX_BYTES);
    expect(JSON.parse(result.content)).toEqual(payload);
  });

  it("refuses a result the model would only see truncated", async () => {
    const { jsonResult } = await import(
      "../../src/server/chat/tools/shared.js"
    );
    const huge = { items: Array.from({ length: 400 }, () => "x".repeat(200)) };
    expect(jsonResult(huge)).toMatchObject({ isError: true });
  });
});

describe("list tools never dead-end on a large page", () => {
  it("shortens a page that would not fit and points nextOffset at the rest", async () => {
    const { MODEL_MAX_BYTES, MODEL_MAX_LINE_CHARS } = await import(
      "@nathapp/nax-agent"
    );
    const { pagedResult } = await import(
      "../../src/server/chat/tools/shared.js"
    );
    const rows = Array.from({ length: 200 }, (_, i) => ({
      i,
      blob: "y".repeat(1500),
    }));
    const first = pagedResult({ buildId: "b" }, rows, 10, 50);
    expect(first.isError).toBeUndefined();
    expect(Buffer.byteLength(first.content)).toBeLessThan(MODEL_MAX_BYTES);
    const lines = first.content.split("\n");
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(
      MODEL_MAX_LINE_CHARS,
    );
    const page = JSON.parse(first.content) as {
      items: { i: number }[];
      total: number;
      nextOffset: number;
      shortened: boolean;
    };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(50);
    expect(page.items[0]?.i).toBe(10);
    expect(page.nextOffset).toBe(10 + page.items.length);
    expect(page).toMatchObject({ total: 200, shortened: true });
  });

  it("keeps a page that fits unchanged", async () => {
    const { pagedResult } = await import(
      "../../src/server/chat/tools/shared.js"
    );
    const page = JSON.parse(
      pagedResult({}, [1, 2, 3], 0, 50).content,
    ) as Record<string, unknown>;
    expect(page).toEqual({ items: [1, 2, 3], total: 3, nextOffset: null });
  });

  it("returns slim transaction rows that still carry what proposals need", async () => {
    const t = await createTestStore();
    open.push(t);
    await seedLedger(t.store);
    const result = await call(
      journalTools(toolContext(t.store)),
      "list_transactions",
      {},
    );
    const row = (
      JSON.parse(result.content) as { items: Record<string, unknown>[] }
    ).items[0];
    expect(row).toBeDefined();
    for (const key of [
      "key",
      "date",
      "symbol",
      "quantity",
      "netCash",
      "brokerPnl",
      "action",
      "sources",
    ]) {
      expect(row).toHaveProperty(key);
    }
    for (const key of [
      "brokerIds",
      "rawDateTime",
      "timezone",
      "account",
      "instrument",
    ]) {
      expect(row).not.toHaveProperty(key);
    }
  });
});

async function waitForJob(ctx: ChatToolContext, jobId: string) {
  const { isTerminalJobStatus } = await import(
    "../../src/server/jobs/service.js"
  );
  for (let i = 0; i < 200; i += 1) {
    const status = ctx.jobs.read(jobId)?.status;
    if (status !== undefined && isTerminalJobStatus(status)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`job ${jobId} did not finish`);
}

describe("repeat-call guard", () => {
  async function guardedTools() {
    const t = await createTestStore();
    open.push(t);
    await seedLedger(t.store);
    const { createChatTools } = await import(
      "../../src/server/chat/tools/index.js"
    );
    const ctx = toolContext(t.store);
    return { ctx, tools: createChatTools(ctx) };
  }

  it("refuses the third identical read call in a turn", async () => {
    const { tools } = await guardedTools();
    const input = { status: "open" };
    expect(await call(tools, "list_strategies", input)).not.toMatchObject({
      isError: true,
    });
    expect(
      await call(tools, "list_strategies", { ...input }),
    ).not.toMatchObject({ isError: true });
    const third = await call(tools, "list_strategies", input);
    expect(third).toMatchObject({ isError: true });
    expect(third.content).toContain("already called list_strategies");
  });

  it("treats inputs with the same values in another key order as identical", async () => {
    const { tools } = await guardedTools();
    await call(tools, "list_strategies", { status: "open", limit: 5 });
    await call(tools, "list_strategies", { limit: 5, status: "open" });
    expect(
      await call(tools, "list_strategies", { status: "open", limit: 5 }),
    ).toMatchObject({ isError: true });
  });

  it("caps calls to one read tool per turn even with different inputs", async () => {
    const { tools } = await guardedTools();
    for (let offset = 0; offset < 30; offset += 1) {
      expect(
        await call(tools, "list_strategies", { offset, limit: 1 }),
      ).not.toMatchObject({ isError: true });
    }
    const over = await call(tools, "list_strategies", { offset: 30, limit: 1 });
    expect(over).toMatchObject({ isError: true });
    expect(over.content).toContain("answer with what you have");
  });

  it("starts fresh on a new turn", async () => {
    const { ctx, tools } = await guardedTools();
    for (let i = 0; i < 2; i += 1) await call(tools, "list_imports", {});
    expect(await call(tools, "list_imports", {})).toMatchObject({
      isError: true,
    });
    ctx.turn.current = {
      turnId: "turn-2",
      proposalRunId: null,
      proposalCount: 0,
    };
    expect(await call(tools, "list_imports", {})).not.toMatchObject({
      isError: true,
    });
  });

  it("lets status polling repeat freely", async () => {
    const { ctx, tools } = await guardedTools();
    const jobId = await ctx.jobs.create("backup", {});
    for (let i = 0; i < 5; i += 1) {
      expect(await call(tools, "get_job", { jobId })).not.toMatchObject({
        isError: true,
      });
    }
  });

  it("allows re-reading after a successful write in the same turn", async () => {
    const { ctx, tools } = await guardedTools();
    for (let i = 0; i < 2; i += 1) await call(tools, "list_imports", {});
    const backup = await call(tools, "create_backup", {});
    expect(backup).not.toMatchObject({ isError: true });
    expect(await call(tools, "list_imports", {})).not.toMatchObject({
      isError: true,
    });
    // Let the background backup finish before the store is torn down.
    const { jobId } = JSON.parse(backup.content) as { jobId: string };
    await waitForJob(ctx, jobId);
  });

  it("keeps counting when the turn scope is replaced mid-turn", async () => {
    // submit_proposal replaces ctx.turn.current with a spread copy.
    const { ctx, tools } = await guardedTools();
    await call(tools, "list_imports", {});
    ctx.turn.current = { ...ctx.turn.current, proposalCount: 1 };
    await call(tools, "list_imports", {});
    expect(await call(tools, "list_imports", {})).toMatchObject({
      isError: true,
    });
  });
});

describe("formatForModel", () => {
  it("omits undefined fields so the result is valid JSON", async () => {
    const { formatForModel } = await import(
      "../../src/server/chat/tools/shared.js"
    );
    const text = formatForModel({ a: 1, b: undefined, items: [1] });
    expect(JSON.parse(text)).toEqual({ a: 1, items: [1] });
  });
});

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
    turn: { current: { proposalRunId: null, proposalCount: 0 } },
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

import type { EmbedderTool } from "@nathapp/nax-agent";
import { afterEach, describe, expect, it } from "vitest";
import { BuildScheduler } from "../../src/server/builds/service.js";
import { journalTools } from "../../src/server/chat/tools/journal.js";
import { pnlTools } from "../../src/server/chat/tools/pnl.js";
import type { ChatToolContext } from "../../src/server/chat/tools/shared.js";
import { JobService } from "../../src/server/jobs/service.js";
import type { Store } from "../../src/server/storage/database.js";
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

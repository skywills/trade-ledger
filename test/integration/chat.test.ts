// test/integration/chat.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { testProfile } from "../../src/server/ai/compatibility.js";
import { createDefaultSecretResolver } from "../../src/server/ai/credentials.js";
import { saveProfile } from "../../src/server/ai/profiles.js";
import { acceptProposal } from "../../src/server/ai/proposals.js";
import { listRunsForThread, readRun } from "../../src/server/ai/runs.js";
import { BuildScheduler } from "../../src/server/builds/service.js";
import type { ChatFrame } from "../../src/server/chat/frames.js";
import { type ChatLimits, ChatService } from "../../src/server/chat/service.js";
import { listMessages, readThread } from "../../src/server/chat/threads.js";
import {
  listImports,
  previewImport,
} from "../../src/server/imports/service.js";
import { JobService } from "../../src/server/jobs/service.js";
import type { Store } from "../../src/server/storage/database.js";
import { fixtures } from "../fixtures/scenarios.js";
import { profileInput, seedLedger, verifiedProfile } from "../helpers/chat.js";
import {
  type InferencePlanStep,
  type InferenceServer,
  startInferenceServer,
} from "../helpers/inference-server.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const stores: TestStore[] = [];
const servers: InferenceServer[] = [];
const services: ChatService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});

async function harness(
  plan: InferencePlanStep[],
  limits: Partial<ChatLimits> = {},
  server: { delayMs?: number; planDelayMs?: number } = {},
  profileMaxTokens?: number,
) {
  const t = await createTestStore();
  stores.push(t);
  await seedLedger(t.store);
  const inference = await startInferenceServer({
    mode: "tool-call",
    plan,
    planGateTool: "get_pnl_summary",
    ...server,
  });
  servers.push(inference);
  const profile =
    profileMaxTokens === undefined
      ? await verifiedProfile(t.store, inference)
      : await saveProfile(
          t.store,
          {
            ...profileInput("chat-local", inference.url),
            contextWindow: 65536,
            maxTokens: profileMaxTokens,
          },
          null,
        );
  if (profileMaxTokens !== undefined) {
    const check = await testProfile(
      t.store,
      profile.id,
      new AbortController().signal,
    );
    expect(check.status).toBe("verified");
  }
  const jobs = new JobService(t.store);
  const chat = new ChatService({
    store: t.store,
    secrets: createDefaultSecretResolver(),
    jobs,
    scheduler: new BuildScheduler(t.store, {}, jobs),
    limits,
  });
  services.push(chat);
  return { store: t.store, chat, profile, inference };
}

async function waitIdle(store: Store, threadId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const thread = readThread(store, threadId);
    if (
      thread !== null &&
      thread.status !== "running" &&
      thread.status !== "waiting"
    )
      return thread;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("thread did not become idle");
}

describe("ChatService read-only turns", () => {
  it("runs a tool-using turn and persists the final answer", async () => {
    const h = await harness([
      { kind: "tool-call", toolName: "get_pnl_summary", arguments: {} },
      { kind: "text", text: "Your USD P&L is shown above." },
    ]);
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    const frames: ChatFrame[] = [];
    h.chat.bus.subscribe(thread.id, (f) => frames.push(f));
    const { assistantMessageId } = await h.chat.sendMessage(thread.id, {
      clientMessageId: "c1",
      text: "What is my P&L?",
    });
    const done = await waitIdle(h.store, thread.id);
    expect(done.status).toBe("idle");
    const assistant = listMessages(h.store, thread.id).find(
      (m) => m.id === assistantMessageId,
    );
    expect(assistant).toMatchObject({
      status: "complete",
      content: "Your USD P&L is shown above.",
    });
    expect(assistant?.tools.map((t) => t.name)).toEqual(["get_pnl_summary"]);
    expect(frames.map((f) => f.event)).toEqual(
      expect.arrayContaining(["tool", "message", "thread"]),
    );
  });

  it("refuses a second send while a turn runs and dedupes clientMessageId", async () => {
    const h = await harness(
      [{ kind: "text", text: "slow" }],
      {},
      { delayMs: 300 },
    );
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    const first = await h.chat.sendMessage(thread.id, {
      clientMessageId: "same",
      text: "hi",
    });
    const again = await h.chat.sendMessage(thread.id, {
      clientMessageId: "same",
      text: "hi",
    });
    expect(again).toEqual(first);
    await expect(
      h.chat.sendMessage(thread.id, { clientMessageId: "other", text: "hi" }),
    ).rejects.toMatchObject({ code: "THREAD_BUSY" });
    await waitIdle(h.store, thread.id);
    expect(
      listMessages(h.store, thread.id).filter((m) => m.role === "user"),
    ).toHaveLength(1);
  });

  it("continues the same conversation after an idle close (resume)", async () => {
    const h = await harness([
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
    ]);
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    await h.chat.sendMessage(thread.id, {
      clientMessageId: "a",
      text: "first",
    });
    await waitIdle(h.store, thread.id);
    await h.chat.sweepIdle(0);
    await h.chat.sendMessage(thread.id, {
      clientMessageId: "b",
      text: "second",
    });
    await waitIdle(h.store, thread.id);
    const last = h.inference.receivedRequests().at(-1)?.body ?? "";
    expect(last).toContain("first");
  });

  it("refuses sends once the thread token cap is reached", async () => {
    const h = await harness([{ kind: "text", text: "x" }], {
      maxThreadGeneratedTokens: 1,
    });
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    await h.chat.sendMessage(thread.id, { clientMessageId: "a", text: "hi" });
    expect((await waitIdle(h.store, thread.id)).status).toBe("limit_reached");
    await expect(
      h.chat.sendMessage(thread.id, { clientMessageId: "b", text: "hi" }),
    ).rejects.toMatchObject({ code: "THREAD_LIMIT_REACHED" });
  });

  it("refuses a send when the profile's model changed after creation", async () => {
    const h = await harness([{ kind: "text", text: "x" }]);
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    const edited = await saveProfile(
      h.store,
      {
        ...profileInput("chat-local", h.inference.url),
        id: h.profile.id,
        modelId: "other-model",
      },
      h.profile.revision,
    );
    await testProfile(h.store, edited.id, new AbortController().signal);
    await expect(
      h.chat.sendMessage(thread.id, { clientMessageId: "a", text: "hi" }),
    ).rejects.toMatchObject({ code: "THREAD_MODEL_CHANGED" });
  });

  it("never offers forbidden built-in tools", async () => {
    const h = await harness([{ kind: "text", text: "x" }]);
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    await h.chat.sendMessage(thread.id, { clientMessageId: "a", text: "hi" });
    await waitIdle(h.store, thread.id);
    const { FORBIDDEN_TOOL_NAMES } = await import(
      "../../src/server/ai/tools.js"
    );
    const offered = new Set<string>();
    for (const r of h.inference.receivedRequests()) {
      for (const t of (
        r.json as { tools?: { function?: { name?: string } }[] } | null
      )?.tools ?? []) {
        if (t.function?.name !== undefined) offered.add(t.function.name);
      }
    }
    expect(offered.has("get_pnl_summary")).toBe(true);
    for (const name of FORBIDDEN_TOOL_NAMES)
      expect(offered.has(name)).toBe(false);
  });

  it("admits exactly one of two concurrent sends", async () => {
    const h = await harness(
      [{ kind: "text", text: "slow" }],
      {},
      { delayMs: 300 },
    );
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    const results = await Promise.allSettled([
      h.chat.sendMessage(thread.id, { clientMessageId: "x1", text: "hi" }),
      h.chat.sendMessage(thread.id, { clientMessageId: "x2", text: "hi" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "THREAD_BUSY" });
    await waitIdle(h.store, thread.id);
    expect(
      listMessages(h.store, thread.id).filter((m) => m.role === "user"),
    ).toHaveLength(1);
  });

  it("cancels a send requested before the session opens", async () => {
    const h = await harness([{ kind: "text", text: "never" }]);
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    const { assistantMessageId } = await h.chat.sendMessage(thread.id, {
      clientMessageId: "c",
      text: "hi",
    });
    h.chat.cancel(thread.id);
    expect((await waitIdle(h.store, thread.id)).status).toBe("idle");
    const assistant = listMessages(h.store, thread.id).find(
      (m) => m.id === assistantMessageId,
    );
    expect(assistant?.status).toBe("cancelled");
  });
});

describe("shutdown", () => {
  it("stops a turn that is still opening or in its first round", async () => {
    const h = await harness(
      [{ kind: "text", text: "slow" }],
      {},
      { planDelayMs: 20_000 },
    );
    const thread = await h.chat.createThread({ profileId: h.profile.id });
    await h.chat.sendMessage(thread.id, { clientMessageId: "s", text: "hi" });
    const started = Date.now();
    await h.chat.close();
    expect(Date.now() - started).toBeLessThan(10_000);
    const after = readThread(h.store, thread.id);
    expect(after?.status).not.toBe("running");
    expect(after?.status).not.toBe("waiting");
  }, 30_000);
});

describe("write tools need the user's approval", () => {
  for (const decision of ["allow", "deny"] as const) {
    it(`commit_import ${decision === "allow" ? "commits and rebuilds" : "changes nothing"} on ${decision}`, async () => {
      const t = await createTestStore();
      stores.push(t);
      const preview = await previewImport(t.store, {
        filename: "chat.csv",
        bytes: fixtures.spread,
        timezone: "UTC",
      });
      const inference = await startInferenceServer({
        mode: "tool-call",
        planGateTool: "get_pnl_summary",
        plan: [
          {
            kind: "tool-call",
            toolName: "commit_import",
            arguments: { previewId: preview.id },
          },
          { kind: "text", text: "finished" },
        ],
      });
      servers.push(inference);
      const profile = await verifiedProfile(t.store, inference);
      const jobs = new JobService(t.store);
      const chat = new ChatService({
        store: t.store,
        secrets: createDefaultSecretResolver(),
        jobs,
        scheduler: new BuildScheduler(t.store, {}, jobs),
      });
      services.push(chat);
      const thread = await chat.createThread({ profileId: profile.id });
      chat.bus.subscribe(thread.id, (frame) => {
        if (frame.event === "approval")
          chat.answer(thread.id, frame.data.requestId, { decision });
      });
      await chat.sendMessage(thread.id, {
        clientMessageId: "c",
        text: "import it",
        attachments: [{ previewId: preview.id, filename: "chat.csv" }],
      });
      await waitIdle(t.store, thread.id);
      const assistant = listMessages(t.store, thread.id).find(
        (m) => m.role === "assistant",
      );
      expect(assistant?.tools[0]).toMatchObject({
        name: "commit_import",
        approval: decision === "allow" ? "allowed" : "denied",
      });
      expect(listImports(t.store)).toHaveLength(decision === "allow" ? 1 : 0);
      const buildJobs = t.store.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'rebuild'")
        .get() as { n: number };
      expect(buildJobs.n > 0).toBe(decision === "allow");
    });
  }

  it("persists a pending approval on the thread while waiting", async () => {
    const t = await createTestStore();
    stores.push(t);
    const inference = await startInferenceServer({
      mode: "tool-call",
      planGateTool: "get_pnl_summary",
      plan: [
        { kind: "tool-call", toolName: "create_backup", arguments: {} },
        { kind: "text", text: "ok" },
      ],
    });
    servers.push(inference);
    const profile = await verifiedProfile(t.store, inference);
    const jobs = new JobService(t.store);
    const chat = new ChatService({
      store: t.store,
      secrets: createDefaultSecretResolver(),
      jobs,
      scheduler: new BuildScheduler(t.store, {}, jobs),
    });
    services.push(chat);
    const thread = await chat.createThread({ profileId: profile.id });
    const seen = new Promise<string>((resolve) =>
      chat.bus.subscribe(thread.id, (f) => {
        if (f.event === "approval") resolve(f.data.requestId);
      }),
    );
    await chat.sendMessage(thread.id, { clientMessageId: "c", text: "backup" });
    const requestId = await seen;
    await expect
      .poll(() => readThread(t.store, thread.id))
      .toMatchObject({
        status: "waiting",
        pending: { kind: "approval", requestId, text: "Create a backup" },
      });
    chat.answer(thread.id, requestId, { decision: "deny" });
    await waitIdle(t.store, thread.id);
  });
});

describe("proposals from chat", () => {
  it("records proposals on a thread run and keeps a mid-turn acceptance", async () => {
    const t = await createTestStore();
    stores.push(t);
    const { ledger } = await seedLedger(t.store);
    const execution = ledger.executions[0];
    if (execution === undefined) throw new Error("no execution");
    const proposal = {
      kind: "manual_allocation",
      strategyIds: ["strategy-test"],
      sources: execution.sources,
      rationale: "r",
      payload: {
        strategyId: "strategy-test",
        source: execution.sources[0],
        allocations: [
          {
            executionKey: execution.key,
            quantity: execution.quantity,
            netCash: execution.netCash,
            brokerPnl: null,
          },
        ],
      },
    };
    const inference = await startInferenceServer({
      mode: "tool-call",
      planGateTool: "get_pnl_summary",
      plan: [
        { kind: "tool-call", toolName: "submit_proposal", arguments: proposal },
        { kind: "tool-call", toolName: "create_backup", arguments: {} }, // blocks on approval so we can accept mid-turn
        { kind: "text", text: "proposed" },
      ],
    });
    servers.push(inference);
    const profile = await verifiedProfile(t.store, inference);
    const jobs = new JobService(t.store);
    const chat = new ChatService({
      store: t.store,
      secrets: createDefaultSecretResolver(),
      jobs,
      scheduler: new BuildScheduler(t.store, {}, jobs),
    });
    services.push(chat);
    const thread = await chat.createThread({ profileId: profile.id });
    let proposalFrame: { runId: string; proposalId: string } | null = null;
    const approval = new Promise<string>((resolve) =>
      chat.bus.subscribe(thread.id, (f) => {
        if (f.event === "proposal") proposalFrame = f.data;
        if (f.event === "approval") resolve(f.data.requestId);
      }),
    );
    await chat.sendMessage(thread.id, {
      clientMessageId: "c",
      text: "reconcile",
    });
    const requestId = await approval;
    expect(proposalFrame).not.toBeNull();
    const { runId, proposalId } = proposalFrame as unknown as {
      runId: string;
      proposalId: string;
    };
    await acceptProposal(t.store, runId, proposalId, 0); // accept while the turn is still running
    chat.answer(thread.id, requestId, { decision: "deny" });
    await waitIdle(t.store, thread.id);
    const run = readRun(t.store, runId);
    expect(run?.threadId).toBe(thread.id);
    expect(run?.proposals[0]?.accepted).toBe(true);
    expect(run?.status).toBe("accepted");
    expect(listRunsForThread(t.store, thread.id)).toHaveLength(1);
  });
});

describe("chat model output limits", () => {
  it.each([
    { profileMaxTokens: 32000, override: {}, status: "complete", error: null },
    {
      profileMaxTokens: 2048,
      override: {},
      status: "failed",
      error: "limit:max_output_tokens",
    },
    {
      profileMaxTokens: 32000,
      override: { maxOutputTokens: 1000 },
      status: "failed",
      error: "limit:max_output_tokens",
    },
  ])(
    "uses the profile limit $profileMaxTokens with override $override",
    async ({ profileMaxTokens, override, status, error }) => {
      const h = await harness(
        [
          {
            kind: "tool-call",
            toolName: "list_transactions",
            arguments: {},
            outputTokens: 4202,
            reasoningTokens: 4095,
          },
          { kind: "text", text: "Finished checking transactions." },
        ],
        override,
        {},
        profileMaxTokens,
      );
      const thread = await h.chat.createThread({ profileId: h.profile.id });
      const { assistantMessageId } = await h.chat.sendMessage(thread.id, {
        clientMessageId: "output-limit",
        text: "Check transactions",
      });
      await waitIdle(h.store, thread.id);
      expect(
        listMessages(h.store, thread.id).find(
          (m) => m.id === assistantMessageId,
        ),
      ).toMatchObject({ status, error });
    },
  );
});

describe("chat cancellation reaches inference", () => {
  it.each([
    { action: "stop", phase: "streaming" },
    { action: "timeout", phase: "streaming" },
    { action: "stop", phase: "headers" },
    { action: "timeout", phase: "headers" },
  ] as const)(
    "$action while awaiting $phase aborts upstream inference and prevents further rounds",
    async ({ action, phase }) => {
      const h = await harness(
        [
          { kind: "tool-call", toolName: "get_pnl_summary", arguments: {} },
          { kind: "text", text: "must not run" },
        ],
        { turnTimeoutSeconds: action === "timeout" ? 1 : 10 },
        phase === "headers" ? { delayMs: 2500 } : { planDelayMs: 2500 },
      );
      const baseline = h.inference.receivedRequests().length;
      const thread = await h.chat.createThread({ profileId: h.profile.id });
      const { assistantMessageId } = await h.chat.sendMessage(thread.id, {
        clientMessageId: action,
        text: "What is my P&L?",
      });
      await expect
        .poll(() => h.inference.receivedRequests().length)
        .toBe(baseline + 1);
      if (action === "stop") h.chat.cancel(thread.id);
      await waitIdle(h.store, thread.id);
      expect(
        listMessages(h.store, thread.id).find(
          (m) => m.id === assistantMessageId,
        ),
      ).toMatchObject({ status: action === "stop" ? "cancelled" : "failed" });
      await expect
        .poll(() => h.inference.interruptedRequests(), { timeout: 1000 })
        .toBe(1);
      // The delayed handler must finish, even after disconnect, before checking
      // that its tool call cannot start another round.
      await h.inference.waitForIdle();
      expect(h.inference.receivedRequests()).toHaveLength(baseline + 1);
    },
    15_000,
  );
});

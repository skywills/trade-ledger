// test/integration/chat.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { testProfile } from "../../src/server/ai/compatibility.js";
import { createDefaultSecretResolver } from "../../src/server/ai/credentials.js";
import { saveProfile } from "../../src/server/ai/profiles.js";
import { BuildScheduler } from "../../src/server/builds/service.js";
import type { ChatFrame } from "../../src/server/chat/frames.js";
import { type ChatLimits, ChatService } from "../../src/server/chat/service.js";
import { listMessages, readThread } from "../../src/server/chat/threads.js";
import { JobService } from "../../src/server/jobs/service.js";
import type { Store } from "../../src/server/storage/database.js";
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
  server: { delayMs?: number } = {},
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
  const profile = await verifiedProfile(t.store, inference);
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

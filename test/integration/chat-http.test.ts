import { get, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { selectDefaultProfile } from "../../src/server/ai/profiles.js";
import {
  type AppContext,
  type AppOptions,
  createApp,
} from "../../src/server/app.js";
import { readConfig } from "../../src/server/config.js";
import { closeStore } from "../../src/server/storage/database.js";
import { ORIGIN, seedLedger, verifiedProfile } from "../helpers/chat.js";
import {
  type InferenceServer,
  type InferenceServerOptions,
  startInferenceServer,
} from "../helpers/inference-server.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const apps: FastifyInstance[] = [];
const servers: InferenceServer[] = [];
const stores: TestStore[] = [];
const streams: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => {
  await Promise.all(
    streams.splice(0).map((reader) => reader.cancel().catch(() => undefined)),
  );
  await Promise.all(apps.splice(0).map((a) => a.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(stores.splice(0).map((s) => s.dispose()));
});

async function appWithModel(
  plan: NonNullable<InferenceServerOptions["plan"]>,
  options: AppOptions = {},
) {
  const t = await createTestStore();
  stores.push(t);
  await seedLedger(t.store);
  const inference = await startInferenceServer({
    mode: "tool-call",
    plan,
    planGateTool: "get_pnl_summary",
  });
  servers.push(inference);
  const profile = await verifiedProfile(t.store, inference);
  await selectDefaultProfile(t.store, profile.id);
  await closeStore(t.store); // the app opens its own store on the same DATA_DIR
  const app = await createApp(
    readConfig({ DATA_DIR: t.dataDir, ALLOWED_ORIGIN: ORIGIN }),
    options,
  );
  apps.push(app);
  return app;
}

async function createChatThread(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat/threads",
    headers: { origin: ORIGIN },
    payload: {},
  });
  return (res.json() as { thread: { id: string } }).thread.id;
}

async function idle(app: FastifyInstance, id: string) {
  for (let i = 0; i < 800; i += 1) {
    const detail = (await app.inject(`/api/chat/threads/${id}`)).json() as {
      thread: { status: string };
    };
    if (
      detail.thread.status !== "running" &&
      detail.thread.status !== "waiting"
    )
      return detail;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("not idle");
}

describe("chat HTTP API", () => {
  it("creates a thread, sends, streams and reads back", async () => {
    const app = await appWithModel([
      { kind: "tool-call", toolName: "get_pnl_summary", arguments: {} },
      { kind: "text", text: "done" },
    ]);
    const created = await app.inject({
      method: "POST",
      url: "/api/chat/threads",
      headers: { origin: ORIGIN },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const createdThread = (
      created.json() as { thread: Record<string, unknown> }
    ).thread;
    expect(createdThread).not.toHaveProperty("sessionId");
    expect(createdThread).not.toHaveProperty("nextSeq");
    const id = createdThread.id as string;
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/chat/threads/${id}/messages`,
        headers: { origin: ORIGIN },
        payload: { clientMessageId: "c1", text: "P&L?" },
      });
    const sent = await send();
    expect(sent.statusCode).toBe(202);
    const repeat = await send();
    expect(repeat.json()).toEqual(sent.json());
    const detail = (await idle(app, id)) as unknown as {
      messages: { role: string; content: string }[];
      runs: unknown[];
    };
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(detail.messages[1]?.content).toBe("done");
    const list = (await app.inject("/api/chat/threads")).json() as {
      items: { id: string; title: string }[];
    };
    expect(list.items[0]).toMatchObject({ id, title: "P&L?" });
  });

  it("serves an SSE stream that starts with ready", async () => {
    const app = await appWithModel([{ kind: "text", text: "x" }]);
    const id = await createChatThread(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${base}/api/chat/threads/${id}/events`);
    const reader = response.body?.getReader();
    if (reader !== undefined) streams.push(reader);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const first = new TextDecoder().decode((await reader?.read())?.value);
    expect(first).toContain("event: ready");
  });

  it("closes promptly while a browser still has an SSE stream open", async () => {
    const app = await appWithModel([{ kind: "text", text: "x" }]);
    const id = await createChatThread(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${base}/api/chat/threads/${id}/events`);
    const reader = response.body?.getReader();
    if (reader !== undefined) streams.push(reader);
    const first = new TextDecoder().decode((await reader?.read())?.value);
    expect(first).toContain("event: ready");
    await app.close();
  }, 4000);

  it("drains a large replay and stays subscribed for new frames", async () => {
    let context: AppContext | undefined;
    const app = await appWithModel([], {
      onReady: (value) => {
        context = value;
      },
    });
    const id = await createChatThread(app);
    if (context === undefined) throw new Error("missing app context");
    for (let i = 0; i < 100; i++)
      context.chat.bus.emit(id, {
        event: "delta",
        data: { messageId: "m", text: `${i}:${"x".repeat(2000)}` },
      });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${base}/api/chat/threads/${id}/events`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE reader");
    streams.push(reader);
    let text = "";
    const readThrough = async (marker: string) => {
      while (!text.includes(marker)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        text += new TextDecoder().decode(chunk.value);
      }
    };
    await readThrough('"text":"99:');
    context.chat.bus.emit(id, {
      event: "message",
      data: { messageId: "still-subscribed" },
    });
    await readThrough("still-subscribed");
    expect((text.match(/event: delta/g) ?? []).length).toBe(100);
  }, 4000);

  it("destroys an overflowing socket even when its peer never reads the stream", async () => {
    let context: AppContext | undefined;
    const app = await appWithModel([], {
      onReady: (value) => {
        context = value;
      },
    });
    const id = await createChatThread(app);
    if (context === undefined) throw new Error("missing app context");
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const connected = new Promise<Socket>((resolve) => {
      app.server.once("connection", resolve);
    });
    let response: IncomingMessage | undefined;
    const request = get(`${base}/api/chat/threads/${id}/events`);
    const socket = await connected;
    try {
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        request.once("response", resolve);
        request.once("error", reject);
      });
      response.pause();
      for (let i = 0; i < 1000; i++)
        context.chat.bus.emit(id, {
          event: "delta",
          data: { messageId: "m", text: "x".repeat(2000) },
        });
      // Overflow must close the actual socket, not wait for this paused peer
      // to consume buffered output after its admission slot has been released.
      expect(socket.destroyed).toBe(true);
      const releases = Array.from({ length: 8 }, () =>
        context?.chat.bus.subscribe(id, () => {}),
      );
      for (const release of releases) release?.();
    } finally {
      response?.destroy();
      request.destroy();
      socket.destroy();
    }
  }, 4000);

  it("disconnects an overflowing stream and releases its subscription", async () => {
    let context: AppContext | undefined;
    const app = await appWithModel([], {
      onReady: (value) => {
        context = value;
      },
    });
    const id = await createChatThread(app);
    if (context === undefined) throw new Error("missing app context");
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${base}/api/chat/threads/${id}/events`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE reader");
    streams.push(reader);
    await reader.read();
    // Burst synchronously so the network cannot drain between emissions.
    for (let i = 0; i < 1000; i++)
      context.chat.bus.emit(id, {
        event: "delta",
        data: { messageId: "m", text: "x".repeat(2000) },
      });
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read().catch((error: unknown) => {
        expect(error).toBeInstanceOf(TypeError);
        return { done: true as const, value: undefined };
      });
      if (chunk.done) break;
      bytes += chunk.value.length;
    }
    expect(bytes).toBeLessThan(200000);
    const releases = Array.from({ length: 8 }, () =>
      context?.chat.bus.subscribe(id, () => {}),
    );
    for (const release of releases) release?.();
  }, 4000);

  it("closes a live stream when its thread is deleted", async () => {
    const app = await appWithModel([]);
    const id = await createChatThread(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${base}/api/chat/threads/${id}/events`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing SSE reader");
    streams.push(reader);
    await reader.read();
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/chat/threads/${id}`,
      headers: { origin: ORIGIN },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await reader.read()).toMatchObject({ done: true });
  }, 4000);

  it("rejects excess streams before SSE headers and releases disconnected slots", async () => {
    const app = await appWithModel([]);
    const id = await createChatThread(app);
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `${base}/api/chat/threads/${id}/events`;
    const readers = [];
    for (let i = 0; i < 8; i++) {
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("missing SSE reader");
      streams.push(reader);
      readers.push(reader);
      await reader.read();
    }
    const rejected = await fetch(url);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("content-type")).toContain("application/json");
    await readers[0]?.cancel();
    await expect
      .poll(async () => {
        const response = await fetch(url);
        if (response.status === 200) {
          const reader = response.body?.getReader();
          if (reader !== undefined) {
            streams.push(reader);
            await reader.read();
          }
        }
        return response.status;
      })
      .toBe(200);
  });

  it("validates input and rejects cross-origin mutations", async () => {
    const app = await appWithModel([]);
    const id = await createChatThread(app);
    const empty = await app.inject({
      method: "POST",
      url: `/api/chat/threads/${id}/messages`,
      headers: { origin: ORIGIN },
      payload: { clientMessageId: "c", text: "" },
    });
    expect(empty.statusCode).toBe(400);
    const evil = await app.inject({
      method: "POST",
      url: "/api/chat/threads",
      headers: { origin: "https://evil.test" },
      payload: {},
    });
    expect(evil.statusCode).toBe(403);
    expect((await app.inject("/api/chat/threads/missing")).statusCode).toBe(
      404,
    );
  });

  it("marks a thread interrupted by restart as failed and lets the user continue", async () => {
    const t = await createTestStore();
    stores.push(t);
    const { createThread, updateThread } = await import(
      "../../src/server/chat/threads.js"
    );
    const thread = await createThread(t.store, {
      title: "x",
      sessionId: "s",
      profileId: null,
      modelRef: "m",
      cloudConfirmed: false,
      seed: null,
      now: new Date(),
    });
    await updateThread(t.store, thread.id, {
      status: "running",
      now: new Date(),
    });
    await closeStore(t.store);
    const app = await createApp(
      readConfig({ DATA_DIR: t.dataDir, ALLOWED_ORIGIN: ORIGIN }),
    );
    apps.push(app);
    expect(
      (
        (await app.inject(`/api/chat/threads/${thread.id}`)).json() as {
          thread: { status: string };
        }
      ).thread.status,
    ).toBe("failed");
  });
});

describe("GET /api/analysis", () => {
  it("lists no runs on a fresh store", async () => {
    const t = await createTestStore();
    stores.push(t);
    await closeStore(t.store);
    const app = await createApp(
      readConfig({ DATA_DIR: t.dataDir, ALLOWED_ORIGIN: ORIGIN }),
    );
    apps.push(app);
    const body = (await app.inject("/api/analysis")).json() as {
      items: unknown[];
      total: number;
    };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});

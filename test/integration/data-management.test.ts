import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  recordProfileCheck,
  saveProfile,
  selectDefaultProfile,
} from "../../src/server/ai/profiles.js";
import { type AppContext, createApp } from "../../src/server/app.js";
import { appendMessage, createThread } from "../../src/server/chat/threads.js";
import { readConfig } from "../../src/server/config.js";
import { closeStore } from "../../src/server/storage/database.js";
import { recordDecision } from "../../src/server/storage/decisions.js";
import { ORIGIN, profileInput, seedLedger } from "../helpers/chat.js";
import { createTestStore, type TestStore } from "../helpers/store.js";

const apps: FastifyInstance[] = [];
const stores: TestStore[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
});
async function setup(seed = false) {
  const t = await createTestStore();
  stores.push(t);
  if (seed) await seedLedger(t.store);
  await closeStore(t.store);
  let context!: AppContext;
  const app = await createApp(
    readConfig({ DATA_DIR: t.dataDir, ALLOWED_ORIGIN: ORIGIN }),
    {
      onReady: (value) => {
        context = value;
      },
    },
  );
  apps.push(app);
  return { app, context, dataDir: t.dataDir };
}
const headers = { origin: ORIGIN };

describe("portable model configuration", () => {
  it("exports settings with credential references and imports unchecked profiles", async () => {
    const { app, context } = await setup();
    await saveProfile(
      context.store,
      {
        ...profileInput("portable", "http://localhost:11434/v1"),
        credentialRef: "env:PORTABLE_KEY",
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      null,
    );
    const exported = await app.inject("/api/models/configuration");
    expect(exported.statusCode).toBe(200);
    const config = exported.json();
    expect(config).toMatchObject({
      version: 1,
      profiles: [
        {
          name: "portable",
          credentialRef: "env:PORTABLE_KEY",
          pricing: { input: 1, output: 2 },
        },
      ],
    });
    expect(config.profiles[0]).not.toHaveProperty("id");
    expect(config.profiles[0]).not.toHaveProperty("compatibility");
    const target = await setup();
    const imported = await target.app.inject({
      method: "POST",
      url: "/api/models/configuration",
      headers,
      payload: config,
    });
    expect(imported.statusCode).toBe(201);
    const models = (await target.app.inject("/api/models")).json();
    expect(models.defaultProfileId).toBeNull();
    expect(models.profiles[0]).toMatchObject({
      name: "portable",
      credentialRef: "env:PORTABLE_KEY",
      compatibility: { status: "unchecked" },
    });
    const selected = await target.app.inject({
      method: "POST",
      url: "/api/models/default",
      headers,
      payload: { id: models.profiles[0].id },
    });
    expect(selected.statusCode).toBe(200);
    const chat = await target.app.inject({
      method: "POST",
      url: "/api/chat/threads",
      headers,
      payload: {},
    });
    expect(chat.statusCode).toBe(409);
    expect(chat.json().code).toBe("PROFILE_NOT_VERIFIED");
  });
  it("exports and imports every profile when more than 100 are saved", async () => {
    const { app, context } = await setup();
    for (let index = 0; index < 101; index += 1) {
      await saveProfile(
        context.store,
        profileInput(`profile-${index}`, "http://localhost:11434/v1"),
        null,
      );
    }
    const exported = await app.inject("/api/models/configuration");
    expect(exported.statusCode).toBe(200);
    expect(exported.json().profiles).toHaveLength(101);
    const target = await setup();
    expect(
      (
        await target.app.inject({
          method: "POST",
          url: "/api/models/configuration",
          headers,
          payload: exported.json(),
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await target.app.inject("/api/models")).json().profiles,
    ).toHaveLength(101);
  });
  it("rejects invalid entries and name conflicts without partially importing", async () => {
    const { app, context } = await setup();
    const input = profileInput("existing", "http://localhost:11434/v1");
    await saveProfile(context.store, input, null);
    for (const profiles of [
      [{ ...input, name: "new" }, input],
      [
        { ...input, name: "new" },
        {
          ...input,
          name: "bad",
          endpoint: "http://localhost/v1?api_key=secret",
        },
      ],
      [{ ...input, name: "new", credentialRef: "raw-secret" }],
      [
        { ...input, name: "repeat" },
        { ...input, name: "repeat" },
      ],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/models/configuration",
        headers,
        payload: { version: 1, profiles },
      });
      expect([400, 409]).toContain(response.statusCode);
      expect(
        (await app.inject("/api/models"))
          .json()
          .profiles.map((p: { name: string }) => p.name),
      ).toEqual(["existing"]);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/models/configuration",
          headers: { origin: "https://evil.test" },
          payload: { version: 1, profiles: [input] },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe("journal reset", () => {
  it("requires confirmation and clears journal records and files while preserving models and backups", async () => {
    const { app, context, dataDir } = await setup(true);
    const profile = await saveProfile(
      context.store,
      profileInput("keep", "http://localhost:11434/v1"),
      null,
    );
    await recordProfileCheck(context.store, {
      profileId: profile.id,
      profileRevision: profile.revision,
      status: "verified",
      checkedAt: new Date().toISOString(),
      durationMs: 1,
      endpoint: profile.endpoint,
      modelId: profile.modelId,
      reason: null,
    });
    await selectDefaultProfile(context.store, profile.id);
    const thread = await createThread(context.store, {
      title: "remove",
      sessionId: "remove-session",
      profileId: profile.id,
      modelRef: "test",
      cloudConfirmed: false,
      seed: null,
      now: new Date(),
    });
    await appendMessage(context.store, thread.id, {
      role: "user",
      content: "Remove this message",
      attachments: [],
      status: "complete",
      clientMessageId: "reset-message",
      now: new Date(),
    });
    const firstDecision = await recordDecision(context.store, {
      kind: "note",
      payload: { text: "old" },
      author: "user",
    });
    await recordDecision(context.store, {
      kind: "note",
      payload: { text: "new" },
      author: "user",
      supersedesId: firstDecision.id,
    });
    mkdirSync(join(dataDir, "transcripts", "chat"), { recursive: true });
    writeFileSync(join(dataDir, "transcripts", "chat", "remove.json"), "{}");
    mkdirSync(join(dataDir, "backups"), { recursive: true });
    writeFileSync(join(dataDir, "backups", "keep.tar"), "backup");
    const preview = await app.inject("/api/maintenance/reset");
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      imports: 1,
      conversations: 1,
      builds: 1,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/maintenance/reset",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject("/api/imports")).json().total).toBe(1);
    const response = await app.inject({
      method: "POST",
      url: "/api/maintenance/reset",
      headers,
      payload: { confirmation: "RESET" },
    });
    expect(response.statusCode).toBe(200);
    expect((await app.inject("/api/imports")).json().total).toBe(0);
    expect((await app.inject("/api/chat/threads")).json().total).toBe(0);
    expect(
      (await app.inject(`/api/chat/threads/${thread.id}`)).statusCode,
    ).toBe(404);
    expect((await app.inject("/api/journal")).json().buildId).toBeNull();
    expect((await app.inject("/api/models")).json()).toMatchObject({
      defaultProfileId: profile.id,
      profiles: [{ id: profile.id, compatibility: { status: "verified" } }],
    });
    expect(readdirSync(join(dataDir, "originals"))).toEqual([]);
    expect(
      existsSync(join(dataDir, "transcripts", "chat", "remove.json")),
    ).toBe(false);
    expect(existsSync(join(dataDir, "backups", "keep.tar"))).toBe(true);
    for (const table of [
      "chat_messages",
      "chat_threads",
      "ai_runs",
      "decisions",
      "identity_bindings",
      "strategy_identities",
      "strategy_views",
      "strategy_allocations",
      "position_views",
      "strategy_links",
      "review_items",
      "builds",
      "ledger_builds",
      "transaction_revisions",
      "transaction_sources",
      "ledger_issues",
      "lot_details",
      "imports",
      "import_rows",
      "import_previews",
      "accounts",
      "jobs",
    ]) {
      expect(
        context.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(),
        table,
      ).toEqual({ n: 0 });
    }
    expect(context.store.db.pragma("foreign_key_check")).toEqual([]);
    await seedLedger(context.store);
    expect((await app.inject("/api/imports")).json().total).toBe(1);
  });
  it("refuses reset while another mutation is still awaiting work", async () => {
    const { app } = await setup(true);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    app.addHook("preHandler", async (request) => {
      if (request.method === "POST" && request.url === "/api/models") {
        entered();
        await waiting;
      }
    });
    const mutation = app
      .inject({
        method: "POST",
        url: "/api/models",
        headers,
        payload: profileInput("during-reset", "http://localhost:11434/v1"),
      })
      .then((response) => response);
    await started;
    try {
      const reset = await app.inject({
        method: "POST",
        url: "/api/maintenance/reset",
        headers,
        payload: { confirmation: "RESET" },
      });
      expect(reset.statusCode).toBe(409);
      expect((await app.inject("/api/imports")).json().total).toBe(1);
    } finally {
      release();
    }
    expect((await mutation).statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/maintenance/reset",
          headers,
          payload: { confirmation: "RESET" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject("/api/models")).json().profiles[0].name).toBe(
      "during-reset",
    );
  });
  it.each([
    { name: "disconnected", created: true },
    { name: "", created: false },
  ])(
    "releases a disconnected mutation only after its handler settles (created=$created)",
    async ({ name, created }) => {
      const { app } = await setup(true);
      let release!: () => void;
      let entered!: () => void;
      let closed!: () => void;
      let completed!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const disconnected = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const settled = new Promise<void>((resolve) => {
        completed = resolve;
      });
      app.addHook("preHandler", async (request) => {
        if (request.method === "POST" && request.url === "/api/models") {
          request.raw.socket.once("close", closed);
          entered();
          await waiting;
        }
      });
      app.addHook("onSend", async (request, _reply, payload) => {
        if (request.method === "POST" && request.url === "/api/models")
          completed();
        return payload;
      });
      const base = await app.listen({ port: 0, host: "127.0.0.1" });
      const payload = JSON.stringify(
        profileInput(name, "http://localhost:11434/v1"),
      );
      const client = httpRequest(`${base}/api/models`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      });
      client.on("error", () => {});
      client.end(payload);
      await started;
      client.destroy();
      await disconnected;
      const reset = () =>
        app.inject({
          method: "POST",
          url: "/api/maintenance/reset",
          headers,
          payload: { confirmation: "RESET" },
        });
      try {
        expect((await reset()).statusCode).toBe(409);
      } finally {
        release();
      }
      await settled;
      expect((await reset()).statusCode).toBe(200);
      const profiles = (await app.inject("/api/models")).json().profiles;
      if (created) expect(profiles[0].name).toBe("disconnected");
      else expect(profiles).toEqual([]);
    },
  );
  it("refuses reset during active work, including cancelled work that has not settled", async () => {
    const { app, context } = await setup(true);
    const job = await context.jobs.create("backup", {});
    context.jobs.register(job, new AbortController());
    const reset = () =>
      app.inject({
        method: "POST",
        url: "/api/maintenance/reset",
        headers,
        payload: { confirmation: "RESET" },
      });
    expect((await reset()).statusCode).toBe(409);
    await context.jobs.cancel(job);
    expect((await reset()).statusCode).toBe(409);
    await context.jobs.finishIfRunning(job, "cancelled");
    expect((await reset()).statusCode).toBe(200);
  });
});

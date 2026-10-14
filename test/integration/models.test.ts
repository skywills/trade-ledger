import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { testProfile } from "../../src/server/ai/compatibility.js";
import {
  createSecretResolver,
  LOCAL_PLACEHOLDER_API_KEY,
  redactHeaders,
  redactSecrets,
} from "../../src/server/ai/credentials.js";
import {
  listProfiles,
  type ProfileInput,
  readCompatibility,
  saveProfile,
  selectDefaultProfile,
  snapshotProfile,
} from "../../src/server/ai/profiles.js";
import { openModelConnection } from "../../src/server/ai/transport.js";
import { createApp } from "../../src/server/app.js";
import { readConfig } from "../../src/server/config.js";
import {
  closeStore,
  openStore,
  type Store,
} from "../../src/server/storage/database.js";
import {
  type InferenceServer,
  startInferenceServer,
} from "../helpers/inference-server.js";

const servers: InferenceServer[] = [];
const stores: Store[] = [];
const dataDirs: string[] = [];
const apps: FastifyInstance[] = [];
const ORIGIN = "http://localhost:3000";

function signal(): AbortSignal {
  return new AbortController().signal;
}

function baseInput(
  patch: Partial<ProfileInput> & Pick<ProfileInput, "name" | "endpoint">,
): ProfileInput {
  return {
    mode: "local",
    provider: "openai",
    protocol: "openai-completions",
    modelId: "test-local-a",
    contextWindow: 8192,
    maxTokens: 1024,
    timeoutSeconds: 10,
    supportsTools: true,
    thinkingLevels: ["off"],
    credentialRef: null,
    ...patch,
  };
}

async function testStore(): Promise<Store> {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-models-"));
  dataDirs.push(dataDir);
  const store = openStore(dataDir);
  stores.push(store);
  return store;
}

async function server(
  options: Parameters<typeof startInferenceServer>[0] = {},
): Promise<InferenceServer> {
  const started = await startInferenceServer(options);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(stores.splice(0).map((store) => closeStore(store)));
  await Promise.all(servers.splice(0).map((entry) => entry.close()));
  await Promise.all(
    dataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local model profiles and guarded transport", () => {
  it("verifies a tool-capable profile and skips a text-only profile", async () => {
    const store = await testStore();
    const localServer = await server({ mode: "tool-call" });
    const textServer = await server({ mode: "text" });
    const otherOrigin = await server({ mode: "tool-call" });
    const cloudServer = await server({ mode: "tool-call" });

    const localA = await saveProfile(
      store,
      baseInput({ name: "local-a", endpoint: localServer.url }),
      null,
    );
    const textOnly = await saveProfile(
      store,
      baseInput({
        name: "text-only",
        endpoint: textServer.url,
        modelId: "test-text-only",
        supportsTools: false,
      }),
      null,
    );

    expect(snapshotProfile(store, localA.id).modelId).toBe("test-local-a");
    expect((await testProfile(store, localA.id, signal())).status).toBe(
      "verified",
    );
    expect((await testProfile(store, textOnly.id, signal())).reason).toBe(
      "TOOLS_UNSUPPORTED",
    );
    expect(otherOrigin.receivedRequests()).toHaveLength(0);
    expect(cloudServer.receivedRequests()).toHaveLength(0);
  });

  it("routes each profile's calls only to its own endpoint", async () => {
    const store = await testStore();
    const first = await server({ mode: "tool-call", modelId: "test-local-a" });
    const second = await server({ mode: "tool-call", modelId: "test-local-b" });

    const profileA = await saveProfile(
      store,
      baseInput({ name: "a", endpoint: first.url, modelId: "test-local-a" }),
      null,
    );
    const profileB = await saveProfile(
      store,
      baseInput({ name: "b", endpoint: second.url, modelId: "test-local-b" }),
      null,
    );

    expect((await testProfile(store, profileA.id, signal())).status).toBe(
      "verified",
    );
    expect((await testProfile(store, profileB.id, signal())).status).toBe(
      "verified",
    );

    expect(first.receivedRequests()).toHaveLength(1);
    expect(second.receivedRequests()).toHaveLength(1);
    expect(first.receivedRequests()[0]?.json).toMatchObject({
      model: "test-local-a",
    });
    expect(second.receivedRequests()[0]?.json).toMatchObject({
      model: "test-local-b",
    });
  });

  it("sends the documented local placeholder and never borrows an ambient cloud key", async () => {
    const store = await testStore();
    const localServer = await server({ mode: "tool-call" });
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-cloud-secret-must-not-appear";
    try {
      const profile = await saveProfile(
        store,
        baseInput({ name: "local", endpoint: localServer.url }),
        null,
      );
      expect((await testProfile(store, profile.id, signal())).status).toBe(
        "verified",
      );
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }

    const received = localServer.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(
      `Bearer ${LOCAL_PLACEHOLDER_API_KEY}`,
    );
    expect(JSON.stringify(received)).not.toContain(
      "sk-cloud-secret-must-not-appear",
    );
  });

  it("injects a resolved upstream credential for a cloud profile through the gateway", async () => {
    const store = await testStore();
    const cloudServer = await server({ mode: "tool-call" });
    const realised = createSecretResolver({
      env: { JOURNAL_TEST_CLOUD_KEY: "sk-real-cloud-key-value" },
      allowedFileRoots: [],
    });
    const profile = await saveProfile(
      store,
      baseInput({
        name: "cloud",
        endpoint: cloudServer.url,
        mode: "cloud",
        credentialRef: "env:JOURNAL_TEST_CLOUD_KEY",
      }),
      null,
    );

    const connection = await openModelConnection(
      snapshotProfile(store, profile.id),
      realised,
    );
    try {
      const response = await fetch(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test-local-a", messages: [] }),
      });
      expect(response.status).toBe(200);
    } finally {
      await connection.close();
    }

    const received = cloudServer.receivedRequests();
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(
      "Bearer sk-real-cloud-key-value",
    );
    expect(received[0]?.headers.authorization).not.toBe(
      `Bearer ${connection.token}`,
    );
  });

  it("redacts credential, header and URL secrets", () => {
    const message =
      "POST http://user:sup3rsecret@upstream.test/v1?api_key=abc123 " +
      "authorization: Bearer sk-live-999 x-api-key: xyz789";

    const redacted = redactSecrets(message);
    expect(redacted).not.toContain("sup3rsecret");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("sk-live-999");
    expect(redacted).not.toContain("xyz789");

    expect(
      redactHeaders({
        authorization: "Bearer sk-live-999",
        "x-api-key": "xyz789",
        accept: "application/json",
      }),
    ).toEqual({
      authorization: "[redacted]",
      "x-api-key": "[redacted]",
      accept: "application/json",
    });
  });

  it("accepts manual model-ID entry and rejects invalid limits", async () => {
    const store = await testStore();
    const custom = await saveProfile(
      store,
      baseInput({
        name: "manual",
        endpoint: "http://127.0.0.1:9/v1",
        modelId: "my-local-model:latest",
      }),
      null,
    );
    expect(snapshotProfile(store, custom.id).modelId).toBe(
      "my-local-model:latest",
    );

    await expect(
      saveProfile(
        store,
        baseInput({
          name: "bad-limits",
          endpoint: "http://127.0.0.1:9/v1",
          contextWindow: 100,
          maxTokens: 100,
        }),
        null,
      ),
    ).rejects.toThrow();
    await expect(
      saveProfile(
        store,
        baseInput({
          name: "bad-endpoint",
          endpoint: "http://user:pass@127.0.0.1:9/v1",
        }),
        null,
      ),
    ).rejects.toThrow();
    await expect(
      saveProfile(
        store,
        baseInput({
          name: "bad-timeout",
          endpoint: "http://127.0.0.1:9/v1",
          timeoutSeconds: 0,
        }),
        null,
      ),
    ).rejects.toThrow();
  });

  it("distinguishes unreachable, timeout, malformed-arguments and no-tool-call", async () => {
    const store = await testStore();
    const malformed = await server({ mode: "malformed-arguments" });
    const silent = await server({ mode: "no-tool-call" });
    const slow = await server({ mode: "tool-call", delayMs: 4000 });

    const unreachable = await saveProfile(
      store,
      baseInput({
        name: "unreachable",
        endpoint: "http://127.0.0.1:1/v1",
        timeoutSeconds: 5,
      }),
      null,
    );
    const malformedProfile = await saveProfile(
      store,
      baseInput({ name: "malformed", endpoint: malformed.url }),
      null,
    );
    const noToolCall = await saveProfile(
      store,
      baseInput({ name: "silent", endpoint: silent.url, supportsTools: true }),
      null,
    );
    const timeout = await saveProfile(
      store,
      baseInput({
        name: "timeout",
        endpoint: slow.url,
        timeoutSeconds: 1,
      }),
      null,
    );

    expect((await testProfile(store, unreachable.id, signal())).reason).toBe(
      "UNREACHABLE",
    );
    expect(
      (await testProfile(store, malformedProfile.id, signal())).reason,
    ).toBe("MALFORMED_ARGUMENTS");
    expect((await testProfile(store, noToolCall.id, signal())).reason).toBe(
      "NO_TOOL_CALL",
    );
    expect((await testProfile(store, timeout.id, signal())).reason).toBe(
      "TIMEOUT",
    );
  });

  it("invalidates a compatibility check when the profile is edited", async () => {
    const store = await testStore();
    const localServer = await server({ mode: "tool-call" });
    const profile = await saveProfile(
      store,
      baseInput({ name: "edited", endpoint: localServer.url }),
      null,
    );

    const verified = await testProfile(store, profile.id, signal());
    expect(verified.status).toBe("verified");
    expect(readCompatibility(store, profile.id).status).toBe("verified");

    const edited = await saveProfile(
      store,
      baseInput({
        id: profile.id,
        name: "edited",
        endpoint: localServer.url,
        modelId: "test-local-a-v2",
      }),
      verified.profileRevision,
    );
    expect(edited.revision).toBe(verified.profileRevision + 1);
    expect(readCompatibility(store, profile.id).status).toBe("unchecked");
  });

  it("does not silently replace a local default with a cloud profile", async () => {
    const store = await testStore();
    const localServer = await server({ mode: "tool-call" });
    const cloudServer = await server({ mode: "tool-call" });
    const local = await saveProfile(
      store,
      baseInput({ name: "local-default", endpoint: localServer.url }),
      null,
    );
    const cloud = await saveProfile(
      store,
      baseInput({
        name: "cloud-default",
        endpoint: cloudServer.url,
        mode: "cloud",
        credentialRef: "env:JOURNAL_TEST_CLOUD_KEY",
      }),
      null,
    );

    await selectDefaultProfile(store, local.id);
    await expect(selectDefaultProfile(store, cloud.id)).rejects.toThrow();
    expect(readDefault(store)).toBe(local.id);

    await selectDefaultProfile(store, cloud.id, { confirmCloud: true });
    expect(readDefault(store)).toBe(cloud.id);
  });

  it("rejects unknown gateway paths and unauthenticated calls", async () => {
    const store = await testStore();
    const localServer = await server({ mode: "tool-call" });
    const profile = await saveProfile(
      store,
      baseInput({ name: "gateway", endpoint: localServer.url }),
      null,
    );
    const secrets = createSecretResolver({
      env: {},
      allowedFileRoots: [],
    });
    const connection = await openModelConnection(
      snapshotProfile(store, profile.id),
      secrets,
    );
    try {
      const unknown = await fetch(`${connection.baseUrl}/admin`);
      expect(unknown.status).toBe(404);

      const noToken = await fetch(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      expect(noToken.status).toBe(401);

      const wrongToken = await fetch(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer not-the-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ messages: [] }),
      });
      expect(wrongToken.status).toBe(401);
      expect(localServer.receivedRequests()).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("refuses to follow a redirect to a different origin", async () => {
    const store = await testStore();
    const attacker = await server({ mode: "tool-call" });
    const upstream = await server({
      redirectTo: `${attacker.url}/chat/completions`,
    });
    const profile = await saveProfile(
      store,
      baseInput({ name: "redirect", endpoint: upstream.url }),
      null,
    );
    const secrets = createSecretResolver({ env: {}, allowedFileRoots: [] });
    const connection = await openModelConnection(
      snapshotProfile(store, profile.id),
      secrets,
    );
    try {
      const response = await fetch(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test-local-a", messages: [] }),
      });
      expect(response.ok).toBe(false);
    } finally {
      await connection.close();
    }

    expect(upstream.receivedRequests()).toHaveLength(1);
    expect(attacker.receivedRequests()).toHaveLength(0);
  });

  it("persists saved profiles across a restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-models-restart-"));
    dataDirs.push(dataDir);
    const first = openStore(dataDir);
    const profile = await saveProfile(
      first,
      baseInput({ name: "persisted", endpoint: "http://127.0.0.1:9/v1" }),
      null,
    );
    await closeStore(first);

    const second = openStore(dataDir);
    stores.push(second);
    const reread = snapshotProfile(second, profile.id);
    expect(reread.modelId).toBe("test-local-a");
    expect(reread.revision).toBe(1);
    expect(listProfiles(second).map((entry) => entry.id)).toContain(profile.id);
  });
});

describe("model profile HTTP routes", () => {
  async function routeApp(): Promise<FastifyInstance> {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-models-http-"));
    dataDirs.push(dataDir);
    const app = await createApp(
      readConfig({ DATA_DIR: dataDir, ALLOWED_ORIGIN: ORIGIN }),
    );
    apps.push(app);
    return app;
  }

  it("creates, lists, tests and defaults a profile without leaking secrets", async () => {
    const localServer = await server({ mode: "tool-call" });
    const cloudServer = await server({ mode: "tool-call" });
    process.env.JOURNAL_ROUTE_KEY = "sk-route-secret-value";
    try {
      const app = await routeApp();

      const created = await app.inject({
        method: "POST",
        url: "/api/models",
        headers: { origin: ORIGIN },
        payload: baseInput({ name: "route-local", endpoint: localServer.url }),
      });
      expect(created.statusCode, created.body).toBe(201);
      const localId = (created.json() as { profile: { id: string } }).profile
        .id;

      const list = await app.inject("/api/models");
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).not.toContain(
        "sk-route-secret-value",
      );

      const tested = await app.inject({
        method: "POST",
        url: `/api/models/${localId}/test`,
        headers: { origin: ORIGIN },
      });
      expect(tested.statusCode, tested.body).toBe(200);
      expect(
        (tested.json() as { result: { status: string } }).result.status,
      ).toBe("verified");

      const selected = await app.inject({
        method: "POST",
        url: "/api/models/default",
        headers: { origin: ORIGIN },
        payload: { id: localId },
      });
      expect(selected.statusCode, selected.body).toBe(200);
      expect(
        (selected.json() as { defaultProfileId: string }).defaultProfileId,
      ).toBe(localId);

      const cloud = await app.inject({
        method: "POST",
        url: "/api/models",
        headers: { origin: ORIGIN },
        payload: baseInput({
          name: "route-cloud",
          endpoint: cloudServer.url,
          mode: "cloud",
          credentialRef: "env:JOURNAL_ROUTE_KEY",
        }),
      });
      expect(cloud.statusCode, cloud.body).toBe(201);
      const cloudProfile = (
        cloud.json() as {
          profile: { id: string; credential: { configured: boolean } };
        }
      ).profile;
      expect(cloudProfile.credential.configured).toBe(true);
      expect(JSON.stringify(cloud.json())).not.toContain(
        "sk-route-secret-value",
      );

      const unconfirmed = await app.inject({
        method: "POST",
        url: "/api/models/default",
        headers: { origin: ORIGIN },
        payload: { id: cloudProfile.id },
      });
      expect(unconfirmed.statusCode).toBe(409);
    } finally {
      delete process.env.JOURNAL_ROUTE_KEY;
    }
  });

  it("rejects cross-origin model mutations", async () => {
    const app = await routeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/models",
      headers: { origin: "https://evil.test" },
      payload: baseInput({ name: "x", endpoint: "http://127.0.0.1:9/v1" }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "CROSS_ORIGIN_REJECTED" });
  });
});

/** Reads the default pointer through the public snapshot path. */
function readDefault(store: Store): string | null {
  const row = store.db
    .prepare(
      "SELECT default_profile_id AS id FROM app_state WHERE singleton = 1",
    )
    .get() as { id: string | null } | undefined;
  return row?.id ?? null;
}

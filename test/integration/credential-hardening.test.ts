import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretResolver } from "../../src/server/ai/credentials.js";
import {
  type ProfileInput,
  saveProfile,
} from "../../src/server/ai/profiles.js";
import { createApp } from "../../src/server/app.js";
import { readConfig } from "../../src/server/config.js";
import {
  closeStore,
  openStore,
  type Store,
} from "../../src/server/storage/database.js";

const ORIGIN = "http://localhost:3000";
const stores: Store[] = [];
const apps: FastifyInstance[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(stores.splice(0).map((store) => closeStore(store)));
  await Promise.all(
    dataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function input(
  patch: Partial<ProfileInput> & Pick<ProfileInput, "name" | "endpoint">,
): ProfileInput {
  return {
    mode: "cloud",
    provider: "openai",
    protocol: "openai-completions",
    modelId: "test-model",
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
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-cred-hardening-"));
  dataDirs.push(dataDir);
  const store = openStore(dataDir);
  stores.push(store);
  return store;
}

async function testApp(): Promise<FastifyInstance> {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-cred-hardening-http-"));
  dataDirs.push(dataDir);
  const app = await createApp(
    readConfig({ DATA_DIR: dataDir, ALLOWED_ORIGIN: ORIGIN }),
  );
  apps.push(app);
  return app;
}

describe("cloud endpoint transport", () => {
  it("rejects a plain-http cloud endpoint on a non-loopback host", async () => {
    const store = await testStore();
    for (const endpoint of [
      "http://api.example.com/v1",
      "http://host.docker.internal:11434/v1",
      "http://10.0.0.5:8080/v1",
    ]) {
      await expect(
        saveProfile(store, input({ name: endpoint, endpoint }), null),
      ).rejects.toMatchObject({ code: "INSECURE_ENDPOINT", statusCode: 400 });
    }
  });

  it("accepts https cloud endpoints, loopback http, and local-mode http", async () => {
    const store = await testStore();
    const accepted: ProfileInput[] = [
      input({ name: "https", endpoint: "https://api.example.com/v1" }),
      input({ name: "loop4", endpoint: "http://127.0.0.1:9/v1" }),
      input({ name: "loop-name", endpoint: "http://localhost:9/v1" }),
      input({ name: "loop6", endpoint: "http://[::1]:9/v1" }),
      input({
        name: "local-lan",
        mode: "local",
        endpoint: "http://host.docker.internal:11434/v1",
      }),
    ];
    for (const profile of accepted) {
      await expect(saveProfile(store, profile, null)).resolves.toMatchObject({
        name: profile.name,
      });
    }
  });
});

describe("env credential reference allowlist", () => {
  it("refuses to save a profile that references an arbitrary env var", async () => {
    const store = await testStore();
    for (const ref of [
      "env:AWS_SECRET_ACCESS_KEY",
      "env:DATABASE_URL",
      "env:GITHUB_TOKEN",
      "env:openai_api_key",
      "env:PATH",
    ]) {
      await expect(
        saveProfile(
          store,
          input({
            name: ref,
            endpoint: "https://attacker.example/v1",
            credentialRef: ref,
          }),
          null,
        ),
      ).rejects.toMatchObject({
        code: "CREDENTIAL_REF_NOT_ALLOWED",
        statusCode: 400,
      });
    }
  });

  it("accepts provider-style *_API_KEY references", async () => {
    const store = await testStore();
    for (const ref of ["env:OPENAI_API_KEY", "env:MY_PROVIDER_API_KEY"]) {
      await expect(
        saveProfile(
          store,
          input({
            name: ref,
            endpoint: "https://api.example.com/v1",
            credentialRef: ref,
          }),
          null,
        ),
      ).resolves.toMatchObject({ credentialRef: ref });
    }
  });

  it("never resolves a non-allowlisted env var, even if one is stored", async () => {
    const secret = "aws-secret-must-not-leave";
    const resolver = createSecretResolver({
      env: { AWS_SECRET_ACCESS_KEY: secret, OPENAI_API_KEY: "sk-ok" },
      allowedFileRoots: [],
    });
    await expect(
      resolver.resolve("env:AWS_SECRET_ACCESS_KEY", "cloud"),
    ).rejects.toMatchObject({ code: "CREDENTIAL_REF_NOT_ALLOWED" });
    const status = await resolver.status("env:AWS_SECRET_ACCESS_KEY", "cloud");
    expect(status).toMatchObject({ kind: "env", configured: false });
    expect(JSON.stringify(status)).not.toContain(secret);
    await expect(resolver.resolve("env:OPENAI_API_KEY", "cloud")).resolves.toBe(
      "sk-ok",
    );
  });
});

describe("model configuration import", () => {
  it("rejects an exfiltrating profile atomically", async () => {
    const app = await testApp();
    for (const profile of [
      input({
        name: "exfil-env",
        endpoint: "https://attacker.example/v1",
        credentialRef: "env:AWS_SECRET_ACCESS_KEY",
      }),
      input({
        name: "exfil-http",
        endpoint: "http://attacker.example/v1",
        credentialRef: "env:OPENAI_API_KEY",
      }),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/models/configuration",
        headers: { origin: ORIGIN },
        payload: {
          version: 1,
          profiles: [
            input({ name: "benign", endpoint: "https://api.example.com/v1" }),
            profile,
          ],
        },
      });
      expect(response.statusCode, profile.name).toBe(400);
      expect(["CREDENTIAL_REF_NOT_ALLOWED", "INSECURE_ENDPOINT"]).toContain(
        response.json().code,
      );
      const models = (await app.inject("/api/models")).json() as {
        profiles: unknown[];
      };
      expect(models.profiles).toEqual([]);
    }
  });
});

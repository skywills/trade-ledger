import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { readConfig } from "../../src/server/config.js";

const ORIGIN = "http://localhost:3000";

const apps: FastifyInstance[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    dataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function hostApp(
  env: Record<string, string> = {},
): Promise<FastifyInstance> {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-host-guard-"));
  dataDirs.push(dataDir);
  const webDir = join(dataDir, "web");
  await mkdir(webDir);
  await writeFile(join(webDir, "index.html"), "<!doctype html><p>app</p>");
  await writeFile(join(webDir, "app.js"), "console.info('app');");
  const app = await createApp(
    readConfig({
      DATA_DIR: join(dataDir, "data"),
      ALLOWED_ORIGIN: ORIGIN,
      STATIC_DIR: webDir,
      ...env,
    }),
  );
  apps.push(app);
  return app;
}

describe("Host header allowlist (DNS rebinding)", () => {
  it("rejects a rebinding Host on API reads, the SPA and static assets", async () => {
    const app = await hostApp();
    for (const url of ["/api/journal", "/api/models", "/", "/app.js"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { host: "evil.example:3000" },
      });
      expect(response.statusCode, url).toBe(421);
      expect(response.json()).toEqual({
        code: "HOST_NOT_ALLOWED",
        message: expect.any(String),
      });
    }
  });

  it("rejects a rebinding Host on mutations even with the allowed Origin", async () => {
    const app = await hostApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/builds",
      headers: { host: "evil.example:3000", origin: ORIGIN },
      payload: { mode: "full" },
    });
    expect(response.statusCode).toBe(421);
    expect(response.json()).toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("accepts the ALLOWED_ORIGIN host and loopback hosts", async () => {
    const app = await hostApp();
    for (const host of [
      "localhost:3000",
      "LOCALHOST:3000",
      "127.0.0.1:3000",
      "[::1]:3000",
      // app.inject's default Host; a loopback name is never a rebinding target.
      "localhost:80",
    ]) {
      const api = await app.inject({
        method: "GET",
        url: "/api/journal",
        headers: { host },
      });
      expect(api.statusCode, host).toBe(200);
      const page = await app.inject({
        method: "GET",
        url: "/",
        headers: { host },
      });
      expect(page.statusCode, host).toBe(200);
    }
    expect((await app.inject("/api/journal")).statusCode).toBe(200);
  });

  it("derives the allowed host from a non-loopback ALLOWED_ORIGIN", async () => {
    const app = await hostApp({ ALLOWED_ORIGIN: "https://journal.example" });
    const ok = await app.inject({
      method: "GET",
      url: "/api/journal",
      headers: { host: "journal.example" },
    });
    expect(ok.statusCode).toBe(200);
    const wrongPort = await app.inject({
      method: "GET",
      url: "/api/journal",
      headers: { host: "journal.example:8443" },
    });
    expect(wrongPort.statusCode).toBe(421);
  });

  it("accepts extra hosts from ALLOWED_HOSTS", async () => {
    const app = await hostApp({
      ALLOWED_HOSTS: "journal.lan:3000, Proxy.Example",
    });
    for (const host of ["journal.lan:3000", "proxy.example"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/journal",
        headers: { host },
      });
      expect(response.statusCode, host).toBe(200);
    }
    const other = await app.inject({
      method: "GET",
      url: "/api/journal",
      headers: { host: "journal.lan:4000" },
    });
    expect(other.statusCode).toBe(421);
  });

  it("rejects malformed Host headers", async () => {
    const app = await hostApp();
    for (const host of ["localhost:3000/evil", "user@localhost:3000", "a b"]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/journal",
        headers: { host },
      });
      expect(response.statusCode, host).toBe(421);
    }
  });
});

describe("allowed host configuration", () => {
  it("parses ALLOWED_HOSTS and rejects malformed entries", () => {
    expect(readConfig({}).allowedHosts).toEqual(["localhost:3000"]);
    expect(
      readConfig({ ALLOWED_ORIGIN: "https://journal.example" }).allowedHosts,
    ).toEqual(["journal.example"]);
    expect(
      readConfig({ ALLOWED_HOSTS: "a.example:8080,,B.example " }).allowedHosts,
    ).toEqual(["localhost:3000", "a.example:8080", "b.example"]);
    expect(() => readConfig({ ALLOWED_HOSTS: "http://a.example" })).toThrow();
    expect(() => readConfig({ ALLOWED_HOSTS: "a.example/path" })).toThrow();
  });
});

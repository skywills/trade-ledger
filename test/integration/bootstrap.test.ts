import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "@nathapp/nax-agent";
import { createClient } from "@nathapp/nax-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { readConfig } from "../../src/server/config.js";
import { fixtures } from "../fixtures/scenarios.js";

const apps: Array<{ close: () => Promise<void> }> = [];
const appDataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    appDataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("standalone app bootstrap", () => {
  it("provides runtime defaults and rejects malformed configuration", () => {
    expect(readConfig({ DATA_DIR: "/tmp/journal" }).port).toBe(3000);
    expect(readConfig({}).dataDir).toBe(".data");
    expect(readConfig({}).uploadLimitBytes).toBe(20 * 1024 * 1024);
    expect(() => readConfig({ PORT: "0" })).toThrow();
    expect(() => readConfig({ PORT: "3000x" })).toThrow();
    expect(() => readConfig({ ALLOWED_ORIGIN: "not-an-origin" })).toThrow();
    expect(() =>
      readConfig({ ALLOWED_ORIGIN: "https://example.test/path" }),
    ).toThrow();
    expect(() => readConfig({ UPLOAD_LIMIT_BYTES: "-1" })).toThrow();
    expect(() => readConfig({ UPLOAD_LIMIT_BYTES: "1.5" })).toThrow();
  });

  it("creates a Fastify app that answers its liveness endpoint", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-journal-"));
    appDataDirs.push(dataDir);
    const app = await createApp(readConfig({ DATA_DIR: dataDir }));
    apps.push(app);

    expect((await app.inject("/health/live")).statusCode).toBe(200);
  });

  it("keeps the installed Nax libraries consumable from their public Node exports", () => {
    expect(typeof createAgentSession).toBe("function");
    expect(typeof createClient).toBe("function");
  });

  it("provides non-empty synthetic fixture bytes for scenarios A through C", () => {
    expect(Object.keys(fixtures).sort()).toEqual([
      "assignment",
      "partialFills",
      "reduced",
      "spread",
    ]);
    for (const bytes of Object.values(fixtures)) {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
    expect(new TextDecoder().decode(fixtures.spread)).toContain("-1402.23006");
    expect(new TextDecoder().decode(fixtures.assignment)).toContain(
      "119280546",
    );
    expect(new TextDecoder().decode(fixtures.partialFills)).toContain(
      "EXEC-C-1",
    );
    expect(new TextDecoder().decode(fixtures.reduced)).not.toContain(
      "PositionActionID",
    );
  });
});

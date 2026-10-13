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
      "roll",
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

  it("includes both supporting lot rows with their source opening time", () => {
    const rows = new TextDecoder()
      .decode(fixtures.spread)
      .trim()
      .split("\n")
      .filter((row) => row.endsWith(",lot"));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("2418.647637");
    expect(rows[1]).toContain("-2870.308382");
    expect(rows.every((row) => row.includes("2026-09-03 10:00:00"))).toBe(true);
  });

  it("keeps the two equal partial fills separate from a mixed-role roll order", () => {
    const partialFillRows = new TextDecoder()
      .decode(fixtures.partialFills)
      .trim()
      .split("\n");
    const roll = new TextDecoder().decode(
      (fixtures as Record<string, Uint8Array>).roll,
    );
    const rollRows = roll.trim().split("\n").slice(1);

    expect(partialFillRows).toHaveLength(3);
    expect(rollRows).toHaveLength(2);
    expect(rollRows.filter((row) => row.includes("ORDER-ROLL"))).toHaveLength(
      2,
    );
    expect(rollRows.some((row) => row.includes(",C,ORDER-ROLL,"))).toBe(true);
    expect(rollRows.some((row) => row.includes(",O,ORDER-ROLL,"))).toBe(true);
  });

  it("removes lifecycle IDs and event codes from the reduced export", () => {
    const reduced = new TextDecoder().decode(fixtures.reduced);

    expect(reduced).not.toContain("PositionActionID");
    expect(reduced).not.toContain("A;C");
    expect(reduced).not.toContain("A;O");
    expect(reduced).not.toContain("C;Ex");
  });
});

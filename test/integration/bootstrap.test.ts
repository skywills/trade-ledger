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

function headers(bytes: Uint8Array): string[] {
  const line = new TextDecoder().decode(bytes).trim().split("\n").at(0);
  if (line === undefined) throw new Error("CSV fixture must include a header.");
  return line.split(",");
}

function records(bytes: Uint8Array): Array<Record<string, string>> {
  const [, ...lines] = new TextDecoder().decode(bytes).trim().split("\n");
  const fixtureHeaders = headers(bytes);
  return lines.map((line) => {
    const values = line.split(",");
    return Object.fromEntries(
      fixtureHeaders.map((header, index) => [header, values[index] ?? ""]),
    );
  });
}

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
    const rows = records(fixtures.spread).filter(
      (row) => row.LevelOfDetail === "CLOSED_LOT",
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.FifoPnlRealized)).toEqual([
      "2418.647637",
      "-2870.308382",
    ]);
    expect(
      rows.every((row) => row.OpenDateTime === "2026-09-03 10:00:00"),
    ).toBe(true);
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

  it("uses IBKR account, currency, date, and detail headers with explicit source values", () => {
    for (const [name, bytes] of Object.entries(fixtures)) {
      const fixtureHeaders = headers(bytes);

      for (const requiredHeader of [
        "ClientAccountID",
        "AssetClass",
        "Symbol",
        "UnderlyingSymbol",
        "Conid",
        "CurrencyPrimary",
        "TradeDate",
        "DateTime",
        "Quantity",
        "TradePrice",
        "NetCash",
        "IBOrderID",
        "BrokerageOrderID",
        "IBExecID",
        "TradeID",
        "LevelOfDetail",
      ]) {
        expect(fixtureHeaders, `${name}: ${requiredHeader}`).toContain(
          requiredHeader,
        );
      }
      expect(fixtureHeaders, name).not.toContain("Account");
      for (const row of records(bytes)) {
        expect(row.ClientAccountID, name).toMatch(/^SIM-/);
        expect(row.CurrencyPrimary, name).toBe("USD");
        expect(row.TradeDate, name).toMatch(/^2026-09-\d{2}$/);
        expect(row.DateTime, name).toMatch(/^2026-09-\d{2} /);
        expect(["EXECUTION", "CLOSED_LOT"], name).toContain(row.LevelOfDetail);
      }
    }
  });

  it("retains shared BrokerageOrderIDs and distinct underlying contract IDs", () => {
    const executions = records(fixtures.spread).filter(
      (row) => row.LevelOfDetail === "EXECUTION",
    );
    const openingOrderIds = executions
      .filter((row) => row.TradeDate === "2026-09-03")
      .map((row) => row.BrokerageOrderID);
    const closingOrderIds = executions
      .filter((row) => row.TradeDate === "2026-09-25")
      .map((row) => row.BrokerageOrderID);

    expect(openingOrderIds).toEqual([
      "BROKER-OPEN-SPREAD",
      "BROKER-OPEN-SPREAD",
    ]);
    expect(closingOrderIds).toEqual([
      "BROKER-CLOSE-SPREAD",
      "BROKER-CLOSE-SPREAD",
    ]);
    expect(executions.every((row) => row.IBOrderID !== "")).toBe(true);
    expect(executions.every((row) => row.UnderlyingSymbol === "AXON")).toBe(
      true,
    );
    expect(new Set(executions.map((row) => row.Conid))).toEqual(
      new Set(["9000470", "9000480"]),
    );
    expect(executions.map((row) => row.Quantity)).toEqual([
      "+1",
      "-1",
      "-1",
      "+1",
    ]);
    expect(executions.map((row) => row.NetCash)).toEqual([
      "-1402.23006",
      "1686.7318978",
      "3820.8776968",
      "-4557.04028",
    ]);
    expect(executions.map((row) => row.FifoPnlRealized)).toEqual([
      "",
      "",
      "2418.647637",
      "-2870.308382",
    ]);
  });

  it("uses VIX for the isolated equal partial-fill fixture", () => {
    const partialFills = records(fixtures.partialFills);

    expect(partialFills).toHaveLength(2);
    expect(partialFills.every((row) => row.UnderlyingSymbol === "VIX")).toBe(
      true,
    );
    expect(partialFills.map((row) => row.Quantity)).toEqual(["+2", "+2"]);
    expect(partialFills.map((row) => row.TradePrice)).toEqual(["1.25", "1.25"]);
    expect(new Set(partialFills.map((row) => row.IBExecID)).size).toBe(2);
  });

  it("keeps stock Put/Call blank and closed lots distinct from cash executions", () => {
    const assignmentRows = records(fixtures.assignment);
    const stockRows = assignmentRows.filter((row) => row.AssetClass === "STK");
    const closedLots = records(fixtures.spread).filter(
      (row) => row.LevelOfDetail === "CLOSED_LOT",
    );

    expect(stockRows.length).toBeGreaterThan(0);
    expect(stockRows.every((row) => row["Put/Call"] === "")).toBe(true);
    expect(stockRows.map((row) => row.NetCash)).toEqual([
      "-10500",
      "9999.7745",
    ]);
    expect(assignmentRows.map((row) => row.PositionActionID)).toEqual([
      "119280546",
      "119280546",
      "119326170",
      "119326170",
    ]);
    expect(closedLots).toHaveLength(2);
    expect(closedLots.map((row) => row.Quantity)).toEqual(["+1", "-1"]);
    expect(closedLots.every((row) => row.NetCash === "")).toBe(true);
  });

  it("gives every execution a valid NetCash value while lot rows remain non-cash", () => {
    for (const [name, bytes] of Object.entries(fixtures)) {
      const executions = records(bytes).filter(
        (row) => row.LevelOfDetail === "EXECUTION",
      );

      expect(executions.length, name).toBeGreaterThan(0);
      for (const row of executions) {
        expect(row.NetCash, `${name}: ${row.TradeID}`).toMatch(
          /^-?\d+(?:\.\d+)?$/,
        );
      }
    }

    const closedLots = records(fixtures.spread).filter(
      (row) => row.LevelOfDetail === "CLOSED_LOT",
    );
    expect(closedLots.every((row) => row.NetCash === "")).toBe(true);
  });
});

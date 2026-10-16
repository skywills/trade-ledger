import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { serializeAnalyticsCsv } from "../../src/server/analytics/csv.js";
import { parseExportQuery } from "../../src/server/analytics/query.js";
import {
  execution,
  performanceFixture,
  snapshot,
} from "../fixtures/analytics.js";

describe("analytics CSV", () => {
  it("escapes text, neutralizes formulas, and retains signed exact decimals", () => {
    const s = snapshot();
    s.ledger!.executions = [
      execution({
        key: "e",
        instrument: { ...execution().instrument, symbol: ' =HYPERLINK("x")' },
        netCash: "-140.60",
        rawDateTime: 'a,"b"\r\nc',
      }),
    ];
    const out = serializeAnalyticsCsv(
      s,
      parseExportQuery({ currency: "USD", dataset: "transactions" }),
    );
    const rows = parse(out.csv, { columns: true }) as Record<string, string>[];
    expect(rows[0]!.symbol).toBe('\' =HYPERLINK("x")');
    expect(rows[0]!.netCash).toBe("-140.60");
    expect(rows[0]!.rawDateTime).toBe('a,"b"\r\nc');
    expect(rows[0]!.buildId).toBe("build");
    expect(rows[0]!.basis).toBe("broker");
  });
  it("exports every selected strategy and rectangular summary with coverage", () => {
    const s = performanceFixture();
    const rows = parse(
      serializeAnalyticsCsv(
        s,
        parseExportQuery({
          currency: "USD",
          dataset: "strategies",
          outcome: "win",
        }),
      ).csv,
      { columns: true },
    );
    expect(rows).toHaveLength(481);
    const all = parse(
      serializeAnalyticsCsv(
        s,
        parseExportQuery({ currency: "USD", dataset: "summary" }),
      ).csv,
    );
    expect(all[0]).toEqual([
      "section",
      "key",
      "metric",
      "value",
      "currency",
      "from",
      "to",
      "basis",
      "buildId",
      "ledgerId",
      "generatedAt",
      "coverageKnown",
      "coverageTotal",
    ]);
    expect(all.every((r: string[]) => r.length === 13)).toBe(true);
    expect(
      all.some((r: string[]) => r[2] === "pnl" && r[3] === "10456.24"),
    ).toBe(true);
  });
  it("keeps headers for empty exports and rejects stale provenance", () => {
    expect(
      parse(
        serializeAnalyticsCsv(
          snapshot(),
          parseExportQuery({ dataset: "strategies" }),
        ).csv,
      ),
    ).toHaveLength(1);
    expect(() =>
      serializeAnalyticsCsv(
        performanceFixture(),
        parseExportQuery({ dataset: "summary", expectedBuildId: "old" }),
      ),
    ).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type { LedgerSnapshot } from "../../src/shared/domain.js";
import { execution, stock } from "../fixtures/lifecycles.js";

const resolveId = (account: string, keys: string[]) =>
  `${account}:${keys.join("+")}`;

describe("strategy grouping chronology integration", () => {
  it("matches a close after an opening by their explicit instants rather than wall-clock text", () => {
    const opening = {
      ...execution("opening", stock, "10", "-100", 1, "open"),
      rawDateTime: "2026-10-01T10:00:00+02:00",
      timezone: null,
      sources: [{ importId: "first-report", rowNumber: 1 }],
    };
    const closing = {
      ...execution("closing", stock, "-10", "120", 1, "close"),
      rawDateTime: "2026-10-01T09:30:00Z",
      timezone: null,
      sources: [{ importId: "second-report", rowNumber: 1 }],
    };
    const ledger: LedgerSnapshot = {
      id: "ledger",
      inputHash: "input",
      executions: [closing, opening],
      lots: [],
      issues: [],
      conflicts: 0,
    };
    const result = groupStrategies(ledger, [], resolveId);
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]).toMatchObject({
      id: "A:opening",
      status: "closed",
      complete: true,
      positions: [{ instrumentKey: "stock", quantity: "0" }],
    });
    expect(
      result.allocations.map((a) => [
        a.strategyId,
        a.executionKey,
        a.quantity,
        a.netCash,
      ]),
    ).toEqual([
      ["A:opening", "closing", "-10", "120"],
      ["A:opening", "opening", "10", "-100"],
    ]);
    expect(result.issues).toEqual([]);
  });

  it("matches a UTC date-only opening before a next-day explicit close", () => {
    const opening = {
      ...execution("opening", stock, "10", "-100", 1, "open"),
      rawDateTime: "2026-10-01",
    };
    const closing = execution("closing", stock, "-10", "120", 2, "close");
    const ledger: LedgerSnapshot = {
      id: "ledger",
      inputHash: "input",
      executions: [closing, opening],
      lots: [],
      issues: [],
      conflicts: 0,
    };
    const result = groupStrategies(ledger, [], resolveId);
    expect(result.strategies).toHaveLength(1);
    expect(result.strategies[0]).toMatchObject({
      id: "A:opening",
      status: "closed",
      complete: true,
      positions: [{ instrumentKey: "stock", quantity: "0" }],
    });
    expect(
      result.allocations.map((a) => [
        a.strategyId,
        a.executionKey,
        a.quantity,
        a.netCash,
      ]),
    ).toEqual([
      ["A:opening", "closing", "-10", "120"],
      ["A:opening", "opening", "10", "-100"],
    ]);
    expect(result.issues).toEqual([]);
  });

  it("keeps same-day unzoned reports unresolved even when key order is deterministic", () => {
    const opening = {
      ...execution("a-opening", stock, "10", "-100", 1, "open"),
      rawDateTime: "2026-10-01T10:00:00",
      timezone: null,
      sources: [{ importId: "first-report", rowNumber: 1 }],
    };
    const closing = {
      ...execution("z-closing", stock, "-10", "120", 1, "close"),
      rawDateTime: "2026-10-01T11:00:00",
      timezone: null,
      sources: [{ importId: "second-report", rowNumber: 1 }],
    };
    const ledger: LedgerSnapshot = {
      id: "ledger",
      inputHash: "input",
      executions: [closing, opening],
      lots: [],
      issues: [],
      conflicts: 0,
    };
    const result = groupStrategies(ledger, [], resolveId);
    expect(result.strategies).toHaveLength(2);
    expect(
      result.strategies.find((s) => s.id === "A:a-opening")?.positions,
    ).toEqual([{ instrumentKey: "stock", quantity: "10" }]);
    expect(result.issues.map((i) => i.code)).toContain("MISSING_OPENING");
    expect(
      groupStrategies(
        { ...ledger, executions: [opening, closing] },
        [],
        resolveId,
      ),
    ).toEqual(result);
  });
});

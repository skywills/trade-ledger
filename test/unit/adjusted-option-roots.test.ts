import { describe, expect, it } from "vitest";
import { resolveAdjustedOptionRoots } from "../../src/server/ledger/adjusted-options.js";
import type { Execution, Instrument } from "../../src/shared/domain.js";

const option = (
  root: string,
  conid: string,
  multiplier: string | null,
): Instrument => ({
  key: `conid:${conid}`,
  assetClass: "OPT",
  symbol: `${root.padEnd(6)}251121C00017000`,
  underlying: root,
  conid,
  expiry: "2025-11-21",
  strike: "17",
  putCall: "C",
  multiplier,
});

function row(
  key: string,
  instrument: Instrument,
  quantity: string,
  at: string,
  action: "open" | "close",
  event: Execution["event"] = "trade",
): Execution {
  return {
    key,
    account: "U1",
    instrument,
    date: at.slice(0, 10),
    rawDateTime: at,
    timezone: "America/New_York",
    quantity,
    price: "0",
    currency: "USD",
    netCash: "0",
    proceeds: null,
    commission: null,
    taxes: null,
    basis: null,
    brokerPnl: null,
    action,
    event,
    brokerIds: {},
    codes: [],
    sources: [{ importId: "imp", rowNumber: Number(key.replace(/\D/g, "")) }],
  };
}

const base = option("SQQQ", "1", "100");
const adjusted = option("SQQQ2", "2", null);

describe("adjusted option roots (SQQQ -> SQQQ2 after a reverse split)", () => {
  it("maps an adjusted contract's expiry onto the still-open original contract", () => {
    const rows = [
      row("r1", base, "2", "2025-11-06T11:07:19", "open"),
      row("r2", adjusted, "-2", "2025-11-21T16:20:00", "close", "expiry"),
    ];
    const mapped = resolveAdjustedOptionRoots(rows);
    expect(mapped).toEqual(["r2"]);
    expect(rows[1]?.instrument).toEqual(base);
  });

  it("leaves a contract that opened under its own symbol alone", () => {
    const rows = [
      row("r1", base, "2", "2025-11-06T11:07:19", "open"),
      row("r2", adjusted, "1", "2025-11-10T10:00:00", "open"),
      row("r3", adjusted, "-1", "2025-11-21T16:20:00", "close", "expiry"),
    ];
    expect(resolveAdjustedOptionRoots(rows)).toEqual([]);
    expect(rows[2]?.instrument).toEqual(adjusted);
  });

  it("leaves it alone when the original contract is already flat", () => {
    const rows = [
      row("r1", base, "2", "2025-11-06T11:07:19", "open"),
      row("r2", base, "-2", "2025-11-07T10:00:00", "close"),
      row("r3", adjusted, "-2", "2025-11-21T16:20:00", "close", "expiry"),
    ];
    expect(resolveAdjustedOptionRoots(rows)).toEqual([]);
  });

  it("leaves it alone when the adjusted closes exceed the open original position", () => {
    const rows = [
      row("r1", base, "1", "2025-11-06T11:07:19", "open"),
      row("r2", adjusted, "-2", "2025-11-21T16:20:00", "close", "expiry"),
    ];
    expect(resolveAdjustedOptionRoots(rows)).toEqual([]);
  });

  it("leaves it alone when the original contract keeps trading afterwards", () => {
    const rows = [
      row("r1", base, "2", "2025-11-06T11:07:19", "open"),
      row("r2", adjusted, "-1", "2025-11-20T10:00:00", "close"),
      row("r3", base, "-1", "2025-11-21T10:00:00", "close"),
    ];
    expect(resolveAdjustedOptionRoots(rows)).toEqual([]);
  });

  it("ignores a root ending in a digit with no original contract", () => {
    const rows = [
      row("r1", adjusted, "-2", "2025-11-21T16:20:00", "close", "expiry"),
    ];
    expect(resolveAdjustedOptionRoots(rows)).toEqual([]);
  });
});

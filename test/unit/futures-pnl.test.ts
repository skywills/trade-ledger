import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { reconstructPnl } from "../../src/server/strategies/reconstructed-pnl.js";
import { execution } from "../fixtures/analytics.js";
import { futuresSpread } from "../fixtures/futures-pnl.js";

const unavailable = {
  value: null,
  method: "trade-proceeds",
  reason: "FUTURES_PNL_UNAVAILABLE",
};
describe("reconstructPnl", () => {
  it.each(["mtm-gap", "coincidental-match"] as const)(
    "reconstructs %s from trade proceeds",
    (variant) => {
      expect(reconstructPnl(futuresSpread(variant))).toEqual({
        value: "14.457979636",
        method: "trade-proceeds",
        reason: null,
      });
    },
  );
  it.each(["proceeds", "commission"] as const)(
    "rejects missing %s",
    (field) => {
      const rows = futuresSpread("mtm-gap");
      (rows[0] as (typeof rows)[number]).execution[field] = null;
      expect(reconstructPnl(rows)).toEqual(unavailable);
    },
  );
  it("treats null taxes as zero and includes explicit taxes", () => {
    const rows = futuresSpread("mtm-gap");
    expect(reconstructPnl(rows).value).toBe("14.457979636");
    (rows[0] as (typeof rows)[number]).execution.taxes = "-1";
    expect(reconstructPnl(rows).value).toBe("13.457979636");
  });
  it.each(["account", "currency"] as const)(
    "rejects mismatched %s",
    (field) => {
      const rows = futuresSpread("mtm-gap");
      (rows[0] as (typeof rows)[number]).execution[field] = "different";
      expect(reconstructPnl(rows)).toEqual(unavailable);
    },
  );
  it("rejects nonzero quantity per contract", () => {
    const rows = futuresSpread("mtm-gap");
    (rows[0] as (typeof rows)[number]).quantity = "-0.5";
    expect(reconstructPnl(rows)).toEqual(unavailable);
  });
  it("rejects zero source quantity", () => {
    const rows = futuresSpread("mtm-gap");
    (rows[0] as (typeof rows)[number]).execution.quantity = "0";
    expect(reconstructPnl(rows)).toEqual(unavailable);
  });
  it("rejects futures expiry events", () => {
    const rows = futuresSpread("mtm-gap");
    (rows[0] as (typeof rows)[number]).execution.event = "expiry";
    expect(reconstructPnl(rows)).toEqual(unavailable);
  });
  it("scales partial slices and complementary partitions", () => {
    const rows = futuresSpread("mtm-gap");
    const partition = (fraction: string) =>
      rows.map((row) => ({
        ...row,
        quantity: new Decimal(row.quantity).mul(fraction).toString(),
        netCash: new Decimal(row.netCash).mul(fraction).toString(),
      }));
    expect(reconstructPnl(partition("0.5")).value).toBe("7.228989818");
    const a = reconstructPnl(partition("0.3")).value ?? "NaN";
    const b = reconstructPnl(partition("0.7")).value ?? "NaN";
    expect(new Decimal(a).plus(b).toString()).toBe(reconstructPnl(rows).value);
  });
  it("sums supplied cash for non-futures", () => {
    const e = execution();
    expect(
      reconstructPnl([
        { execution: e, quantity: "1", netCash: "12" },
        { execution: e, quantity: "1", netCash: "-3" },
      ]),
    ).toEqual({ value: "9", method: "cashflow", reason: null });
  });
  it("combines futures proceeds with ordinary cash", () => {
    const rows = futuresSpread("mtm-gap");
    const e = execution({ account: "SIM-FUT" });
    expect(
      reconstructPnl([...rows, { execution: e, quantity: "1", netCash: "5" }])
        .value,
    ).toBe("19.457979636");
  });
});

import { describe, expect, it } from "vitest";
import { sameInstrument } from "../../src/server/strategies/matching.js";
import type { Instrument } from "../../src/shared/domain.js";

const assignedShares: Instrument = {
  key: "symbol:XYZ",
  assetClass: "STK",
  symbol: "XYZ",
  underlying: null,
  conid: null,
  expiry: null,
  strike: null,
  putCall: null,
  multiplier: "1",
};
const soldShares: Instrument = {
  ...assignedShares,
  underlying: "XYZ",
};

describe("canonical instrument identity", () => {
  it("treats shares sharing a canonical symbol key as one instrument when only one leg names the underlying", () => {
    expect(sameInstrument(assignedShares, soldShares)).toBe(true);
  });

  it("keeps distinct symbols distinct", () => {
    expect(
      sameInstrument(assignedShares, {
        ...soldShares,
        key: "symbol:OTHER",
        symbol: "OTHER",
      }),
    ).toBe(false);
  });

  it("keeps a stock distinct from an option on the same underlying", () => {
    expect(
      sameInstrument(assignedShares, {
        ...soldShares,
        key: "contract:XYZ",
        assetClass: "OPT",
        expiry: "2026-10-16",
        strike: "100",
        putCall: "P",
        multiplier: "100",
      }),
    ).toBe(false);
  });

  it("keeps distinct contract IDs distinct even when their display keys match", () => {
    expect(
      sameInstrument(
        { ...assignedShares, key: "C:100", conid: "first" },
        { ...assignedShares, key: "C:100", conid: "different" },
      ),
    ).toBe(false);
  });
});

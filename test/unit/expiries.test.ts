import { describe, expect, it } from "vitest";
import type { Execution } from "../../src/web/api.js";
import { collectActualExpiries } from "../../src/web/journal/expiries.js";

function execution(key: string, expiry: string | null): Execution {
  return { key, instrument: { expiry } } as unknown as Execution;
}

describe("collectActualExpiries", () => {
  it("omits null expiries so a mixed strategy never renders a blank entry", () => {
    const byKey = new Map<string, Execution>([
      ["a", execution("a", "2026-12-18")],
      ["stock", execution("stock", null)],
      ["b", execution("b", "2027-01-15")],
    ]);

    expect(collectActualExpiries(["a", "stock", "b"], byKey)).toEqual([
      "2026-12-18",
      "2027-01-15",
    ]);
  });

  it("returns an empty list when no allocation has a known expiry", () => {
    const byKey = new Map<string, Execution>([
      ["stock", execution("stock", null)],
    ]);

    expect(collectActualExpiries(["stock"], byKey)).toEqual([]);
  });
});

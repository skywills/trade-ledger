import { describe, expect, it } from "vitest";
import {
  filterStrategies,
  nextSort,
  sortStrategies,
} from "../../src/web/journal/journalView.js";

const rows = [
  {
    id: "a",
    description: "AXON bull put spread",
    currency: "USD",
    status: "closed",
    openingDate: "2026-09-03",
    closeDate: "2026-09-25",
    expiry: "2026-10-16",
    openingAmount: "-284.50",
    brokerPnl: "-451.66",
    reconstructedPnl: "-451.66",
  },
  {
    id: "b",
    description: "SAP iron condor",
    currency: "EUR",
    status: "open",
    openingDate: "2026-08-01",
    closeDate: null,
    expiry: null,
    openingAmount: "120.00",
    brokerPnl: null,
    reconstructedPnl: "35.5",
  },
  {
    id: "c",
    description: "AAPL call",
    currency: "USD",
    status: "open",
    openingDate: "2026-09-10",
    closeDate: null,
    expiry: "2026-12-18",
    openingAmount: "-10",
    brokerPnl: "9",
    reconstructedPnl: null,
  },
];

const ids = (list: { id: string }[]) => list.map((row) => row.id);

describe("filterStrategies", () => {
  it("returns everything for empty filters", () => {
    expect(
      ids(filterStrategies(rows, { currency: "", status: "", query: "" })),
    ).toEqual(["a", "b", "c"]);
  });

  it("combines currency, status and a case-insensitive text query", () => {
    expect(
      ids(
        filterStrategies(rows, { currency: "USD", status: "open", query: "" }),
      ),
    ).toEqual(["c"]);
    expect(
      ids(
        filterStrategies(rows, { currency: "", status: "", query: " axon " }),
      ),
    ).toEqual(["a"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(
      filterStrategies(rows, { currency: "", status: "", query: "zzz" }),
    ).toEqual([]);
  });
});

describe("sortStrategies", () => {
  it("does not mutate its input", () => {
    const copy = [...rows];
    sortStrategies(rows, { key: "description", direction: "asc" });
    expect(rows).toEqual(copy);
  });

  it("sorts text ascending and descending", () => {
    expect(
      ids(sortStrategies(rows, { key: "description", direction: "asc" })),
    ).toEqual(["c", "a", "b"]);
    expect(
      ids(sortStrategies(rows, { key: "description", direction: "desc" })),
    ).toEqual(["b", "a", "c"]);
  });

  it("sorts money columns numerically and keeps nulls last in both directions", () => {
    expect(
      ids(sortStrategies(rows, { key: "brokerPnl", direction: "asc" })),
    ).toEqual(["a", "c", "b"]);
    expect(
      ids(sortStrategies(rows, { key: "brokerPnl", direction: "desc" })),
    ).toEqual(["c", "a", "b"]);
  });

  it("keeps the original order when no sort is set", () => {
    expect(ids(sortStrategies(rows, null))).toEqual(["a", "b", "c"]);
  });
});

describe("nextSort", () => {
  it("cycles none -> asc -> desc -> none for the same column", () => {
    const first = nextSort(null, "expiry");
    expect(first).toEqual({ key: "expiry", direction: "asc" });
    const second = nextSort(first, "expiry");
    expect(second).toEqual({ key: "expiry", direction: "desc" });
    expect(nextSort(second, "expiry")).toBeNull();
  });

  it("starts ascending on a different column", () => {
    expect(nextSort({ key: "expiry", direction: "desc" }, "status")).toEqual({
      key: "status",
      direction: "asc",
    });
  });
});

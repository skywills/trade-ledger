import { describe, expect, it } from "vitest";
import { groupBy } from "../../src/shared/group-by.js";

describe("groupBy", () => {
  it("groups rows by key, keeping input order within each group", () => {
    const rows = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "a", n: 3 },
    ];
    const groups = groupBy(rows, (r) => r.id);
    expect(groups.get("a")).toEqual([rows[0], rows[2]]);
    expect(groups.get("b")).toEqual([rows[1]]);
    expect(groups.get("c")).toBeUndefined();
  });

  it("returns an empty map for no rows", () => {
    expect(groupBy([], (r: string) => r).size).toBe(0);
  });
});

import { expect, it, vi } from "vitest";
import { computeProjection } from "../../src/server/builds/service.js";
import { appendDecision } from "../../src/server/decisions/service.js";
import * as grouping from "../../src/server/strategies/grouping.js";
import { execution, fixture, stock } from "../fixtures/lifecycles.js";
import { createTestStore } from "../helpers/store.js";

function journal() {
  return fixture([
    ["first", execution("first-open", stock, "100", "-10000", 1, "open")],
    ["first", execution("first-close", stock, "-100", "10100", 2, "close")],
    ["second", execution("second-open", stock, "50", "-5000", 3, "open")],
    ["second", execution("second-close", stock, "-50", "5100", 4, "close")],
  ]).ledger;
}

it("groups once when presentation and origin inputs are identical", async () => {
  const t = await createTestStore();
  const group = vi.spyOn(grouping, "groupStrategies");
  try {
    const projection = await computeProjection(t.store, journal(), 0);
    expect(projection.strategies).toHaveLength(2);
    expect(
      projection.lifecycles?.lifecycles.map((l) => l.reconstructedPnl),
    ).toEqual(["100", "100"]);
    expect(group.mock.calls.length).toBe(1);
  } finally {
    group.mockRestore();
    await t.dispose();
  }
});

it("keeps origin grouping separate when a presentation merge is effective", async () => {
  const t = await createTestStore();
  try {
    const ledger = journal();
    const initial = await computeProjection(t.store, ledger, 0);
    const [first, second] = initial.strategies;
    if (!first || !second) throw Error("Missing strategies");
    await appendDecision(
      t.store,
      {
        kind: "group_merge",
        clientRequestId: "merge",
        author: "user",
        payload: { chosenStrategyId: first.id, mergedStrategyIds: [second.id] },
      },
      0,
    );
    const group = vi.spyOn(grouping, "groupStrategies");
    try {
      const merged = await computeProjection(t.store, ledger, 1);
      expect(group.mock.calls.length).toBe(2);
      expect(merged.strategies).toHaveLength(1);
      expect(merged.strategies[0]?.reconstructedPnl).toBe("200");
      expect(
        merged.lifecycles?.lifecycles.map((l) => [l.id, l.reconstructedPnl]),
      ).toEqual(
        initial.lifecycles?.lifecycles.map((l) => [l.id, l.reconstructedPnl]),
      );
      expect(merged.lifecycles?.lifecycles).toHaveLength(2);
    } finally {
      group.mockRestore();
    }
  } finally {
    await t.dispose();
  }
});

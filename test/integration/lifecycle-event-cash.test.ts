import { expect, it } from "vitest";
import { computeProjection } from "../../src/server/builds/service.js";
import { recordDecision } from "../../src/server/storage/decisions.js";
import { assigned } from "../fixtures/lifecycles.js";
import { createTestStore } from "../helpers/store.js";

it("retains corrected physical event cash after merging presentation strategies", async () => {
  const { store, dispose } = await createTestStore();
  try {
    const { ledger } = assigned(true);
    ledger.executions.forEach((e, index) => {
      e.sources = [{ importId: "synthetic", rowNumber: index + 1 }];
    });
    const option = ledger.executions.find((e) => e.key === "p-assign");
    const stock = ledger.executions.find((e) => e.key === "s-buy");
    const source = option?.sources[0];
    const target = stock?.sources[0];
    if (!source || !target) throw Error("Missing event sources");
    const correction = await recordDecision(store, {
      kind: "lifecycle",
      author: "user",
      sources: [source, target],
      payload: { event: "assignment", sourceRef: source, targetRef: target },
    });
    const before = await computeProjection(store, ledger, correction.sequence);
    expect(before.lifecycles?.lifecycles[0]?.reconstructedPnl).toBe("-150");
    const chosen = before.allocations.find(
      (a) => a.executionKey === "p-open",
    )?.strategyId;
    const merged = before.allocations.find(
      (a) => a.executionKey === "s-buy",
    )?.strategyId;
    if (!chosen || !merged) throw Error("Missing presentation strategies");
    const merge = await recordDecision(store, {
      kind: "group_merge",
      author: "user",
      payload: { chosenStrategyId: chosen, mergedStrategyIds: [merged] },
    });
    const after = await computeProjection(store, ledger, merge.sequence);
    expect(after.strategies).toHaveLength(1);
    expect(after.links).toEqual([]);
    expect(after.lifecycles?.lifecycles).toHaveLength(1);
    expect(after.lifecycles?.lifecycles[0]?.reconstructedPnl).toBe("-150");
    expect(after.issues.map((i) => i.code)).not.toContain(
      "EVENT_CASH_UNRESOLVED",
    );
  } finally {
    await dispose();
  }
});

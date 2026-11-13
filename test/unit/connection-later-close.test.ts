import { expect, it } from "vitest";
import { accountLifecycles } from "../../src/server/lifecycles/accounting.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import type { Decision } from "../../src/shared/domain.js";
import { assigned, call, execution, fixture } from "../fixtures/lifecycles.js";

/**
 * Month-by-month imports (XOM 2024 -> 2025): the covered call was connected
 * while only its opening existed. The buy-back arrives in a later import and
 * must follow the opening into the share lifecycle instead of staying behind
 * as an orphan close that keeps the shares reserved.
 */
it("moves a later-imported buy-back along with its connected call", () => {
  const f = assigned();
  const calls = fixture([
    ["calls", execution("c-open", call, "-1", "100", 3, "open")],
    ["calls", execution("c-close", call, "1", "-30", 9, "close")],
  ]);
  f.ledger.executions.push(...calls.ledger.executions);
  f.projection.allocations.push(...calls.projection.allocations);
  f.projection.strategies.push(...calls.projection.strategies);
  const target = projectLifecycles(f.ledger, f.projection, []).lifecycles.find(
    (l) => l.originStrategyType === "short_put",
  )?.id;
  if (!target) throw Error("missing share lifecycle");
  // Saved before the 2025 import: it lists only the opening.
  const connect: Decision = {
    id: "d1",
    sequence: 1,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      requireCallCoverage: true,
      assignments: [
        {
          allocation: {
            strategyId: "calls",
            executionKey: "c-open",
            role: "open",
          },
          lifecycleId: target,
          quantity: "-1",
        },
      ],
    },
  };
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, [connect]),
  );
  expect(
    p.members
      .filter((m) => m.allocation.executionKey === "c-close")
      .map((m) => m.lifecycleId),
  ).toEqual([target]);
  expect(p.issues.map((i) => i.code)).not.toContain(
    "LIFECYCLE_EXPOSURE_UNRESOLVED",
  );
});

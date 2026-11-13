import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { validateLifecycleDecision } from "../../src/server/lifecycles/validate-decision.js";
import type { Decision } from "../../src/shared/domain.js";
import {
  call,
  execution,
  fixture,
  put,
  stock,
} from "../fixtures/lifecycles.js";

/**
 * HIMS 2025: IBKR's FIFO tax lots send a later call's assignment to the share
 * lot that a different, user-connected covered call was holding. The assigned
 * call joins that lifecycle automatically; it must not invalidate the user's
 * covered-call connection, because the user never claimed it as covered there.
 */
it("connects a covered call when another call joined the lot only by assignment", () => {
  const other = { ...call, key: "call-b", conid: "5" };
  const f = fixture(
    [
      ["put-origin", execution("po", put, "-1", "200", 1, "open")],
      ["put-origin", execution("pa", put, "1", "0", 2, "close", "assignment")],
      [
        "stock",
        execution("so", stock, "100", "-10000", 2, "open", "assignment"),
      ],
      [
        "stock",
        execution("sc", stock, "-100", "10500", 8, "close", "assignment"),
      ],
      ["call-a", execution("a-open", call, "-1", "100", 3, "open")],
      ["call-a", execution("a-close", call, "1", "-20", 7, "close")],
      ["call-b", execution("b-open", other, "-1", "120", 4, "open")],
      [
        "call-b",
        execution("b-assign", other, "1", "0", 8, "close", "assignment"),
      ],
    ],
    [
      { from: "put-origin", to: "stock", type: "assignment", sources: [] },
      {
        from: "call-b",
        to: "stock",
        type: "assignment",
        // IBKR links the call assignment to the share call-away row.
        sources: [{ importId: "imp", rowNumber: 8 }],
      },
    ],
  );
  const draft = projectLifecycles(f.ledger, f.projection, []);
  const target = draft.lifecycles.find(
    (l) => l.originStrategyType === "short_put",
  )?.id;
  if (!target) throw Error("missing share lifecycle");
  // Precondition: the assigned call joined the share lifecycle on its own.
  expect(
    draft.members.find((m) => m.allocation.executionKey === "b-open")
      ?.lifecycleId,
  ).toBe(target);
  const connect: Decision = {
    id: "__validate__",
    sequence: 1,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      requireCallCoverage: true,
      assignments: draft.members
        .filter((m) => m.allocation.strategyId === "call-a")
        .map((m) => ({
          allocation: m.allocation,
          lifecycleId: target,
          quantity: m.quantity,
        })),
    },
  };
  expect(() =>
    validateLifecycleDecision(f.ledger, f.projection, [], connect),
  ).not.toThrow();
});

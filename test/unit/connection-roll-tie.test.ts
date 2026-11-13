import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import type { Decision } from "../../src/shared/domain.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

const rolled = { ...call, key: "rolled-call", conid: "4" };

/**
 * A combo roll (HIMS 2025-03-07 10:44:19): the old covered call is bought back
 * and the new call sold in one order, so both fills carry the same timestamp.
 */
function rollAt(newCallTime: string) {
  const { ledger, projection } = fixture([
    ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
    ["old", execution("old-open", call, "-1", "70", 2, "open")],
    [
      "old",
      {
        ...execution("old-close", call, "1", "-30", 3, "close"),
        rawDateTime: "2026-10-03T10:44:19Z",
      },
    ],
    [
      "new",
      {
        ...execution("new-open", rolled, "-1", "60", 3, "open"),
        rawDateTime: newCallTime,
      },
    ],
  ]);
  const initial = projectLifecycles(ledger, projection, []);
  const old = initial.suggestions.find(
    (s) => s.callOpening.executionKey === "old-open",
  );
  const target = old?.candidateLifecycleIds[0];
  if (!old || !target) throw Error("Missing old call connection");
  const oldMembers = initial.members.filter(
    (m) => m.allocation.strategyId === "old",
  );
  const confirmed: Decision = {
    id: "connect-old",
    sequence: 1,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    kind: "lifecycle_membership",
    payload: {
      requireCallCoverage: true,
      assignments: oldMembers.map((m) => ({
        allocation: m.allocation,
        lifecycleId: target,
        quantity: m.quantity,
      })),
    },
  };
  const after = projectLifecycles(ledger, projection, [confirmed]);
  return {
    target,
    next: after.suggestions.find(
      (s) => s.callOpening.executionKey === "new-open",
    ),
  };
}

it("frees shares for a call sold in the same instant the covered call is bought back", () => {
  const { target, next } = rollAt("2026-10-03T10:44:19Z");
  expect(next?.reasons).not.toContain("SHARES_RESERVED_BY_OTHER_CALLS");
  expect(next?.candidateLifecycleIds).toEqual([target]);
});

it("still blocks a call sold while the covered call remains open", () => {
  const { next } = rollAt("2026-10-03T10:44:00Z");
  expect(next?.candidateLifecycleIds).toEqual([]);
  expect(next?.reasons).toContain("SHARES_RESERVED_BY_OTHER_CALLS");
});

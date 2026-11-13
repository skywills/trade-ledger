import { expect, it } from "vitest";
import { unresolvedEventCash } from "../../src/server/lifecycles/event-cash.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { assigned } from "../fixtures/lifecycles.js";

it("sees executions and allocations added to the same ledger between calls", () => {
  const f = assigned();
  const isDelivery = (key: string) => key === "s-buy";
  const delivery = f.ledger.executions.filter((e) => isDelivery(e.key));
  const deliveryAllocations = f.projection.allocations.filter((a) =>
    isDelivery(a.executionKey),
  );
  // Start without the share delivery: the put assignment's cash is unresolved.
  f.ledger.executions.splice(
    0,
    f.ledger.executions.length,
    ...f.ledger.executions.filter((e) => !isDelivery(e.key)),
  );
  f.projection.allocations.splice(
    0,
    f.projection.allocations.length,
    ...f.projection.allocations.filter((a) => !isDelivery(a.executionKey)),
  );
  const without = projectLifecycles(f.ledger, f.projection, []);
  expect(
    unresolvedEventCash(f.ledger, f.projection, without.members),
  ).not.toEqual([]);
  // The delivery arrives in the same arrays (as with a later import); the
  // cached indexes must pick it up, resolving the event cash.
  f.ledger.executions.push(...delivery);
  f.projection.allocations.push(...deliveryAllocations);
  const withDelivery = projectLifecycles(f.ledger, f.projection, []);
  expect(
    unresolvedEventCash(f.ledger, f.projection, withDelivery.members),
  ).toEqual([]);
});

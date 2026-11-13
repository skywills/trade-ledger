import { expect, it } from "vitest";
import { connectionExecutionKeys } from "../../src/server/lifecycles/connection-executions.js";
import type { LifecycleProjection } from "../../src/shared/lifecycles.js";

const ref = (executionKey: string) => ({
  strategyId: "s",
  executionKey,
  allocationKey: `${executionKey}#0`,
});

it("includes every execution a suggestion plan references, once", () => {
  const projection = {
    members: [],
    suggestions: [
      {
        callOpening: ref("open"),
        candidateLifecycleIds: ["l1"],
        plan: {
          action: "separate",
          lifecycleId: "l1",
          reason: "HELD_BY_EARLIER_CALL",
          heldBy: ref("held"),
          sharesSold: { executionKey: "sold" },
          pairedWith: ref("paired"),
          dependsOn: [ref("dep1"), ref("held")],
        },
      },
    ],
  } as unknown as LifecycleProjection;
  const keys = connectionExecutionKeys(projection);
  expect([...keys].sort()).toEqual(["dep1", "held", "paired", "sold"].sort());
});

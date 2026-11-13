import { describe, expect, it } from "vitest";
import {
  restoreDecisionState,
  snapshotDecisionState,
} from "../../src/server/lifecycles/decision-rollback.js";
import type { LifecycleProjection } from "../../src/shared/lifecycles.js";

function draft(): LifecycleProjection {
  return {
    version: 1,
    lifecycles: [
      { id: "L1", reasons: ["A"], campaignId: null },
      { id: "L2", reasons: [], campaignId: "C1" },
    ],
    members: [{ lifecycleId: "L1", quantity: "1" }],
    campaigns: [{ id: "C1", lifecycleIds: [] }],
    suggestions: [],
    issues: [],
    valuations: [],
  } as unknown as LifecycleProjection;
}

describe("decision rollback snapshot", () => {
  it("undoes everything a rejected decision may change", () => {
    const p = draft();
    const original = structuredClone(p);
    const before = snapshotDecisionState(p);

    // The changes applyMembershipChanges makes while applying a decision.
    p.members = p.members.filter(() => false);
    p.members.push({ lifecycleId: "L2" } as never);
    p.lifecycles[0]?.reasons.push("LIFECYCLE_CALL_CLOSE_AMBIGUOUS");
    const second = p.lifecycles[1];
    if (second) second.campaignId = null;
    p.campaigns = p.campaigns.filter(() => false);
    p.campaigns.push({ id: "C2" } as never);
    p.issues.push({ key: "x" } as never);

    restoreDecisionState(p, before);
    expect(p).toEqual(original);
  });

  it("keeps the live objects when the decision is accepted", () => {
    const p = draft();
    const member = p.members[0];
    snapshotDecisionState(p);
    expect(p.members[0]).toBe(member);
  });
});

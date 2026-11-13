import type { LifecycleProjection } from "../../shared/lifecycles.js";

export type DecisionState = Pick<
  LifecycleProjection,
  "members" | "lifecycles" | "campaigns" | "issues"
>;

/**
 * What applying one decision may change, copied so a rejected decision can
 * be undone. A decision replaces member and campaign objects rather than
 * editing them, and on a lifecycle only appends reasons or sets campaignId,
 * so copying those suffices. Deep-cloning the whole projection per decision
 * dominated rebuilds of journals with many confirmed connections.
 */
export function snapshotDecisionState(draft: DecisionState): DecisionState {
  return {
    members: [...draft.members],
    lifecycles: draft.lifecycles.map((l) => ({
      ...l,
      reasons: [...l.reasons],
    })),
    campaigns: [...draft.campaigns],
    issues: [...draft.issues],
  };
}

export function restoreDecisionState(
  draft: DecisionState,
  before: DecisionState,
): void {
  draft.members = before.members;
  draft.lifecycles = before.lifecycles;
  draft.campaigns = before.campaigns;
  draft.issues = before.issues;
}

import { expect, it } from "vitest";
import type { SubmittedProposalDto } from "../../src/shared/api.js";
import { usesGuidedConnectionView } from "../../src/web/review/AgentConnectionProposal.js";

function entry(
  kind: string,
  accepted: boolean,
  payload: Record<string, unknown> = {},
): SubmittedProposalDto {
  return {
    id: "proposal",
    submittedAt: "2024-06-01T00:00:00Z",
    accepted,
    proposal: { kind, payload },
  };
}

it("guides pending attachment and call-coverage membership proposals", () => {
  expect(
    usesGuidedConnectionView(entry("lifecycle_attachment", false), false),
  ).toBe(true);
  expect(
    usesGuidedConnectionView(
      entry("lifecycle_membership", false, { requireCallCoverage: true }),
      false,
    ),
  ).toBe(true);
  expect(
    usesGuidedConnectionView(entry("lifecycle_membership", false), false),
  ).toBe(false);
  expect(usesGuidedConnectionView(entry("strategy_label", false), false)).toBe(
    false,
  );
});

it("shows accepted proposals as plain cards when no review is open", () => {
  expect(
    usesGuidedConnectionView(entry("lifecycle_attachment", true), false),
  ).toBe(false);
});

it("keeps an open review mounted when a refresh marks the proposal accepted", () => {
  // A lost accept response followed by a run refresh must not unmount the
  // dialog, or its onDismiss (and journal recovery) never runs.
  expect(
    usesGuidedConnectionView(entry("lifecycle_attachment", true), true),
  ).toBe(true);
  expect(
    usesGuidedConnectionView(
      entry("lifecycle_membership", true, { requireCallCoverage: true }),
      true,
    ),
  ).toBe(true);
});

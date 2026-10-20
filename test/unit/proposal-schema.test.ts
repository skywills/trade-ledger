import { expect, it } from "vitest";
import {
  ProposalSchema,
  parseProposal,
} from "../../src/server/ai/proposals.js";

const opening = { strategyId: "s", executionKey: "e", role: "open" };
const target = { lifecycleId: "l", quantity: "-1" };
it.each([
  { kind: "import_exclusion", payload: { importId: "i", exclude: false } },
  {
    kind: "lifecycle_attachment",
    payload: { opening, targets: [{ ...target, onlyIfUncovered: true }] },
  },
  {
    kind: "lifecycle_attachment",
    payload: { opening: { ...opening, currency: "EUR" }, targets: [target] },
  },
  {
    kind: "lifecycle_membership",
    payload: {
      assignments: [
        {
          lifecycleId: "l",
          allocation: { ...opening, currency: "EUR" },
          quantity: "-1",
        },
      ],
    },
  },
  {
    kind: "wheel_campaign",
    payload: {
      campaignId: "c",
      name: "Wheel",
      account: "A",
      currency: "USD",
      underlyingKey: "XYZ",
      onlyIfEmpty: true,
    },
  },
  {
    kind: "notes",
    payload: { strategyId: "s", text: "Note" },
    sources: [{ importId: "i", rowNumber: 1, ignore: true }],
  },
  {
    kind: "notes",
    payload: { strategyId: "s", text: "Note", onlyIfEmpty: true },
  },
  {
    kind: "notes",
    payload: { strategyId: "s", text: "Note" },
    author: "model",
  },
])("rejects unknown proposal keys at every input depth: %j", (raw) => {
  expect(ProposalSchema.safeParse(raw).success).toBe(false);
  expect(() => parseProposal(raw)).toThrow();
});

it("strict payloads retain collection and decimal constraints and legacy defaults", () => {
  expect(
    ProposalSchema.safeParse({
      kind: "lifecycle_attachment",
      payload: { opening, targets: [] },
    }).success,
  ).toBe(false);
  expect(
    ProposalSchema.safeParse({
      kind: "lifecycle_attachment",
      payload: { opening, targets: [{ ...target, quantity: -1 }] },
    }).success,
  ).toBe(false);
  expect(
    parseProposal({
      kind: "lifecycle_attachment",
      payload: { opening, targets: [target] },
    }),
  ).toMatchObject({ sources: [], strategyIds: [], supersedesId: null });
  expect(
    parseProposal({
      kind: "notes",
      payload: { strategyId: "s", text: "Old saved note" },
    }),
  ).toMatchObject({ sources: [], strategyIds: [], supersedesId: null });
});

import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { validateLifecycleDecision } from "../../src/server/lifecycles/validate-decision.js";
import type { Decision } from "../../src/shared/domain.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

function setup() {
  const { ledger, projection } = fixture([
    ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
    ["early", execution("early", call, "-1", "70", 2, "open")],
    [
      "late",
      execution(
        "late",
        { ...call, key: "late-call", conid: "4" },
        "-1",
        "70",
        3,
        "open",
      ),
    ],
  ]);
  const initial = projectLifecycles(ledger, projection, []);
  const early = initial.suggestions.find(
    (s) => s.callOpening.executionKey === "early",
  );
  const late = initial.suggestions.find(
    (s) => s.callOpening.executionKey === "late",
  );
  if (!early || !late) throw Error("Missing initial suggestions");
  const connected: Decision = {
    id: "__validate__",
    sequence: 1,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    kind: "lifecycle_attachment",
    payload: {
      opening: early.callOpening,
      targets: [
        { lifecycleId: early.candidateLifecycleIds[0], quantity: "-1" },
      ],
    },
  };
  const rejection: Decision = {
    id: "__validate__",
    sequence: 2,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    kind: "lifecycle_attachment_rejection",
    payload: {
      callOpening: late.callOpening,
      candidateLifecycleIds: [],
      reason: "Independent call trade",
    },
  };
  return { ledger, projection, connected, rejection };
}

it("allows advanced rejection of a current blocked call without moving its source allocations", () => {
  const { ledger, projection, connected, rejection } = setup();
  const before = projectLifecycles(ledger, projection, [connected]);
  expect(before.suggestions[0]?.candidateLifecycleIds).toEqual([]);
  expect(() =>
    validateLifecycleDecision(ledger, projection, [connected], rejection),
  ).not.toThrow();
  const after = projectLifecycles(ledger, projection, [connected, rejection]);
  expect(after.suggestions).toEqual([]);
  expect(after.members).toEqual(before.members);
});

it("rejects an empty-candidate rejection if the call currently has eligible shares", () => {
  const { ledger, projection, rejection } = setup();
  expect(() =>
    validateLifecycleDecision(ledger, projection, [], rejection),
  ).toThrowError(
    expect.objectContaining({ code: "INVALID_LIFECYCLE_MEMBERSHIP" }),
  );
});

it("rejects a repeated rejection after the blocked suggestion has been resolved", () => {
  const { ledger, projection, connected, rejection } = setup();
  expect(() =>
    validateLifecycleDecision(ledger, projection, [connected, rejection], {
      ...rejection,
      sequence: 3,
    }),
  ).toThrowError(
    expect.objectContaining({ code: "INVALID_LIFECYCLE_MEMBERSHIP" }),
  );
});

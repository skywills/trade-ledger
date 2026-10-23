import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { validateLifecycleDecision } from "../../src/server/lifecycles/validate-decision.js";
import type { Decision } from "../../src/shared/domain.js";
import {
  connectionGroups,
  connectionProposal,
} from "../../src/web/lifecycles/connections.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

function setup() {
  const f = fixture([
    ["shares", execution("shares", stock, "200", "-20000", 1, "open")],
    ["early", execution("early", call, "-1", "70", 2, "open")],
    ["early", execution("early-close", call, "1", "-30", 3, "close")],
    [
      "late",
      execution(
        "late",
        { ...call, key: "late-call", conid: "4" },
        "-1",
        "80",
        4,
        "open",
      ),
    ],
  ]);
  const p = projectLifecycles(f.ledger, f.projection, []);
  const groups = connectionGroups(
    p.suggestions,
    p.members,
    f.ledger.executions,
  );
  const early = groups[0];
  const late = groups[1];
  const target = early?.candidateIds[0];
  if (!early || !late || !target) throw new Error("Missing fixture connection");
  const decision = (group: typeof early, separate = false): Decision => ({
    id: "__validate__",
    sequence: 1,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    ...connectionProposal(group, target, separate),
  });
  return { ...f, p, early, late, target, decision };
}

it.each(["lifecycle_membership", "lifecycle_attachment"])(
  "blocks %s behind an earlier pending connection sharing the target",
  (kind) => {
    const { ledger, projection, early, late, target, decision } = setup();
    const candidate = decision(late);
    if (kind === "lifecycle_attachment") {
      candidate.kind = kind;
      candidate.payload = {
        opening: late.suggestions[0]?.callOpening,
        targets: [{ lifecycleId: target, quantity: "-1" }],
      };
    }
    expect(() =>
      validateLifecycleDecision(ledger, projection, [], candidate),
    ).toThrowError(
      expect.objectContaining({
        code: "EARLIER_CONNECTION_UNRESOLVED",
        blockingConnection: {
          date: "2026-10-02",
          lifecycleId: early.members[0]?.lifecycleId,
        },
      }),
    );
  },
);

it("allows the oldest connection and keeping a later call separate", () => {
  const { ledger, projection, early, late, decision } = setup();
  expect(() =>
    validateLifecycleDecision(ledger, projection, [], decision(early)),
  ).not.toThrow();
  expect(() =>
    validateLifecycleDecision(ledger, projection, [], decision(late, true)),
  ).not.toThrow();
});

it("allows a later connection after the earlier one is resolved, even while shares remain open", () => {
  const { ledger, projection, early, late, decision } = setup();
  const prior = { ...decision(early), id: "resolved" };
  expect(() =>
    validateLifecycleDecision(ledger, projection, [prior], {
      ...decision(late),
      sequence: 2,
    }),
  ).not.toThrow();
});

it("allows a proposal that resolves both earlier and later calls together", () => {
  const { ledger, projection, early, late, decision } = setup();
  const candidate = decision(late);
  candidate.payload.assignments = [
    ...connectionProposal(early, "unused").payload.assignments.map((a) => ({
      ...a,
      lifecycleId: late.candidateIds[0],
    })),
    ...connectionProposal(late, late.candidateIds[0] ?? "").payload.assignments,
  ];
  expect(() =>
    validateLifecycleDecision(ledger, projection, [], candidate),
  ).not.toThrow();
});

it("does not block a different share lifecycle for the same underlying", () => {
  const { ledger, projection } = setup();
  const shares = fixture([
    [
      "other-shares",
      execution("other-shares", stock, "100", "-10000", 3, "open"),
    ],
  ]);
  ledger.executions.push(...shares.ledger.executions);
  projection.allocations.push(...shares.projection.allocations);
  projection.strategies.push(...shares.projection.strategies);
  const p = projectLifecycles(ledger, projection, []);
  const target = p.members.find(
    (m) => m.allocation.executionKey === "other-shares",
  )?.lifecycleId;
  const late = connectionGroups(
    p.suggestions,
    p.members,
    ledger.executions,
  ).find((g) => g.instrument.key === "late-call");
  if (!target || !late) throw new Error("Missing new share lifecycle");
  expect(late.candidateIds).toContain(target);
  expect(() =>
    validateLifecycleDecision(ledger, projection, [], {
      id: "__validate__",
      sequence: 1,
      sources: [],
      strategyIds: [],
      supersedesId: null,
      ...connectionProposal(late, target),
    }),
  ).not.toThrow();
});

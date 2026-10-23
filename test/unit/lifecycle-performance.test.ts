import { expect, it, vi } from "vitest";
import { validateMembership } from "../../src/server/lifecycles/membership.js";
import {
  availableShares,
  projectLifecycles,
} from "../../src/server/lifecycles/project.js";
import { execution, fixture, stock } from "../fixtures/lifecycles.js";

function journal(count: number) {
  return fixture(
    Array.from({ length: count }, (_, i) => [
      `strategy-${i}`,
      execution(`shares-${i}`, stock, "100", "-10000", 1, "open"),
    ]),
  );
}

it("validates a large journal without comparing every member with every allocation", () => {
  const { ledger, projection } = journal(200);
  const lifecycle = projectLifecycles(ledger, projection, []);
  let reads = 0;
  for (const allocation of projection.allocations) {
    const id = allocation.strategyId;
    Object.defineProperty(allocation, "strategyId", {
      get() {
        reads++;
        return id;
      },
    });
  }
  expect(validateMembership(ledger, projection, lifecycle.members)).toEqual([]);
  // Bound input reads rather than wall time, which varies between CI machines.
  expect(reads).toBeLessThan(200 * 10);
});

it("resolves presentation allocations without serializing every possible pair", () => {
  const { ledger, projection } = journal(200);
  const serialize = vi.spyOn(JSON, "stringify");
  try {
    const lifecycle = projectLifecycles(
      ledger,
      projection,
      [],
      undefined,
      projection,
    );
    expect(lifecycle.members).toHaveLength(200);
    expect(serialize.mock.calls.length).toBeLessThan(200 * 100);
    expect(validateMembership(ledger, projection, lifecycle.members)).toEqual(
      [],
    );
  } finally {
    serialize.mockRestore();
  }
});

it("share availability reflects membership changes between calculations", () => {
  const { ledger, projection } = journal(1);
  const lifecycle = projectLifecycles(ledger, projection, []);
  const member = lifecycle.members[0];
  if (!member) throw Error("Missing shares");
  const id = member.lifecycleId;
  expect(availableShares(ledger, lifecycle, id).toFixed()).toBe("100");
  member.lifecycleId = "other";
  expect(availableShares(ledger, lifecycle, id).toFixed()).toBe("0");
  member.lifecycleId = id;
  member.quantity = "50";
  expect(availableShares(ledger, lifecycle, id).toFixed()).toBe("50");
});

it("preserves exact allocation identity when an execution has multiple strategy slices", () => {
  const { ledger, projection } = fixture([
    ["first", execution("shared", stock, "100", "-10000", 1, "open")],
    ["second", execution("shared", stock, "50", "-5000", 1, "open")],
  ]);
  const lifecycle = projectLifecycles(
    ledger,
    projection,
    [],
    undefined,
    projection,
  );
  expect(
    lifecycle.members.map((m) => [
      m.allocation.strategyId,
      m.quantity,
      m.netCash,
    ]),
  ).toEqual([
    ["first", "100", "-10000"],
    ["second", "50", "-5000"],
  ]);
});

it("rejects ambiguous execution fallback after presentation regrouping", () => {
  const { ledger, projection } = journal(1);
  const allocation = projection.allocations[0];
  if (!allocation) throw Error("Missing allocation");
  const final = {
    ...projection,
    allocations: [
      {
        ...allocation,
        strategyId: "renamed-a",
        quantity: "50",
        netCash: "-5000",
      },
      {
        ...allocation,
        strategyId: "renamed-b",
        quantity: "50",
        netCash: "-5000",
      },
    ],
  };
  expect(() =>
    projectLifecycles(ledger, final, [], undefined, projection),
  ).toThrow(
    "Cannot resolve lifecycle source allocation after presentation grouping",
  );
});

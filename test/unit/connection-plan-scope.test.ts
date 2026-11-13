import { describe, expect, it, vi } from "vitest";
import {
  type PlanInput,
  planConnections,
} from "../../src/server/lifecycles/connection-plan.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import type {
  Decision,
  Execution,
  Instrument,
} from "../../src/shared/domain.js";
import type { LifecycleProjection } from "../../src/shared/lifecycles.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

const abcStock: Instrument = {
  ...stock,
  key: "abc",
  symbol: "ABC",
  conid: "11",
};
const abcCall: Instrument = {
  ...call,
  key: "abc-call",
  underlying: "ABC",
  conid: "12",
};
const xyzCall2: Instrument = { ...call, key: "xyz-call-2", conid: "13" };

const inAccount = (e: Execution, account: string): Execution => ({
  ...e,
  account,
});

/** XYZ in accounts A and B (A rolls one call into a second) plus ABC in A. */
function world() {
  return fixture([
    ["xa-shares", execution("xa-shares", stock, "100", "-10000", 1, "open")],
    ["xa-call", execution("xa-call", call, "-1", "70", 2, "open")],
    ["xa-call2", execution("xa-call2", xyzCall2, "-1", "60", 3, "open")],
    [
      "xb-shares",
      inAccount(execution("xb-shares", stock, "100", "-10000", 1, "open"), "B"),
    ],
    [
      "xb-call",
      inAccount(execution("xb-call", call, "-1", "70", 2, "open"), "B"),
    ],
    ["ya-shares", execution("ya-shares", abcStock, "100", "-5000", 1, "open")],
    ["ya-call", execution("ya-call", abcCall, "-1", "40", 2, "open")],
  ]);
}

function inputFor(decisions: Decision[]): PlanInput {
  const { ledger, projection } = world();
  return {
    ledger,
    projection,
    decisions,
    lifecycles: projectLifecycles(ledger, projection, decisions),
  };
}

const plansByCall = (p: LifecycleProjection) =>
  Object.fromEntries(
    p.suggestions.map((s) => [s.callOpening.executionKey, s.plan]),
  );

describe("planConnections scoping", () => {
  it("plans every call the same with and without scoping", () => {
    const input = inputFor([]);
    const scoped = plansByCall(planConnections(input));
    const whole = plansByCall(planConnections({ ...input, unscoped: true }));
    expect(Object.keys(scoped).sort()).toEqual([
      "xa-call",
      "xa-call2",
      "xb-call",
      "ya-call",
    ]);
    expect(scoped).toEqual(whole);
    expect(Object.values(scoped).every((p) => p !== undefined)).toBe(true);
  });

  it("is not changed by a decision made in another account", () => {
    const plain = inputFor([]);
    const memberOf = (key: string) =>
      plain.lifecycles.members.find((m) => m.allocation.executionKey === key);
    const target = plain.lifecycles.suggestions.find(
      (s) => s.callOpening.executionKey === "xb-call",
    )?.candidateLifecycleIds[0];
    const member = memberOf("xb-call");
    expect(target && member).toBeTruthy();
    const foreign: Decision = {
      id: "foreign",
      sequence: 1,
      sources: [],
      strategyIds: [],
      supersedesId: null,
      kind: "lifecycle_membership",
      payload: {
        requireCallCoverage: true,
        assignments: [
          {
            allocation: member?.allocation,
            lifecycleId: target,
            quantity: member?.quantity,
          },
        ],
      },
    };
    const withForeign = inputFor([foreign]);
    const mine = (p: LifecycleProjection) =>
      Object.fromEntries(
        Object.entries(plansByCall(p)).filter(([k]) => !k.startsWith("xb")),
      );
    expect(mine(planConnections(withForeign))).toEqual(
      mine(planConnections(plain)),
    );
  });
});

describe("planConnections failures", () => {
  it("leaves a position's rows without a plan when planning it fails unexpectedly", async () => {
    vi.resetModules();
    vi.doMock("../../src/server/lifecycles/validate-decision.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../src/server/lifecycles/validate-decision.js")
      >("../../src/server/lifecycles/validate-decision.js");
      return {
        ...actual,
        validateLifecycleDecision: (
          ...args: Parameters<typeof actual.validateLifecycleDecision>
        ) => {
          const payload = args[3].payload as {
            assignments?: Array<{ allocation: { executionKey: string } }>;
          };
          if (
            payload.assignments?.some((a) =>
              a.allocation.executionKey.startsWith("ya-"),
            )
          )
            throw new Error("boom");
          return actual.validateLifecycleDecision(...args);
        },
      };
    });
    try {
      const mod = await import(
        "../../src/server/lifecycles/connection-plan.js"
      );
      const errors: Array<[unknown, string]> = [];
      const planned = mod.planConnections({
        ...inputFor([]),
        onError: (e, id) => errors.push([e, id]),
      });
      const plans = plansByCall(planned);
      expect(plans["ya-call"]).toBeUndefined();
      expect(plans["xa-call"]).toBeDefined();
      expect(plans["xb-call"]).toBeDefined();
      expect(errors).toHaveLength(1);
      expect(String(errors[0]?.[0])).toBe("Error: boom");
    } finally {
      vi.doUnmock("../../src/server/lifecycles/validate-decision.js");
      vi.resetModules();
    }
  });
});

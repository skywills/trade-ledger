import { describe, expect, it } from "vitest";
import { planConnections } from "../../src/server/lifecycles/connection-plan.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { validateLifecycleDecision } from "../../src/server/lifecycles/validate-decision.js";
import type { Decision, Execution } from "../../src/shared/domain.js";
import type {
  AttachmentSuggestion,
  LifecycleProjection,
} from "../../src/shared/lifecycles.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

const callB = { ...call, key: "call-b", conid: "5" };
const callC = { ...call, key: "call-c", conid: "6" };

function at(e: Execution, time: string): Execution {
  return { ...e, rawDateTime: time };
}

/** NVDA Dec5: A day 2; A bought back and B sold at one instant day 3; C sold day 4 while B is open. */
function chain() {
  const { ledger, projection } = fixture([
    ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
    [
      "a",
      at(
        execution("a-open", call, "-1", "70", 2, "open"),
        "2026-10-02T10:00:00Z",
      ),
    ],
    [
      "a",
      at(
        execution("a-close", call, "1", "-30", 3, "close"),
        "2026-10-03T10:00:00Z",
      ),
    ],
    [
      "b",
      at(
        execution("b-open", callB, "-1", "60", 3, "open"),
        "2026-10-03T10:00:00Z",
      ),
    ],
    [
      "c",
      at(
        execution("c-open", callC, "-1", "50", 4, "open"),
        "2026-10-04T10:00:00Z",
      ),
    ],
  ]);
  const decisions: Decision[] = [];
  const lifecycles = projectLifecycles(ledger, projection, decisions);
  return { ledger, projection, decisions, lifecycles };
}

const planOf = (p: LifecycleProjection, key: string) =>
  p.suggestions.find((s) => s.callOpening.executionKey === key)?.plan;
const refOf = (p: LifecycleProjection, key: string) =>
  p.suggestions.find((s) => s.callOpening.executionKey === key)?.callOpening;

describe("planConnections", () => {
  it("recommends connect for each call in a roll chain", () => {
    const c = chain();
    const planned = planConnections(c);
    const target = c.lifecycles.suggestions[0]?.candidateLifecycleIds[0];
    expect(planOf(planned, "a-open")).toMatchObject({
      action: "connect",
      lifecycleId: target,
      reason: "COVERED",
      sharesAtOpening: "100",
    });
    expect(planOf(planned, "b-open")).toMatchObject({
      action: "connect",
      lifecycleId: target,
      reason: "COVERED_AFTER_EARLIER",
      dependsOn: [refOf(c.lifecycles, "a-open")],
    });
  });

  it("recommends separate when an earlier recommended call still holds the shares", () => {
    const c = chain();
    const planned = planConnections(c);
    expect(planOf(planned, "c-open")).toMatchObject({
      action: "separate",
      reason: "HELD_BY_EARLIER_CALL",
      heldBy: refOf(c.lifecycles, "b-open"),
    });
  });

  it("agrees with validation", () => {
    const c = chain();
    const planned = planConnections(c);
    const rowMembers = (s: AttachmentSuggestion) =>
      c.lifecycles.members.filter(
        (m) => m.allocation.strategyId === s.callOpening.strategyId,
      );
    const decision = (
      id: string,
      sequence: number,
      requireCallCoverage: boolean,
      rows: AttachmentSuggestion[],
      lifecycleOf: (s: AttachmentSuggestion) => string,
    ): Decision => ({
      id,
      sequence,
      sources: [],
      strategyIds: [],
      supersedesId: null,
      kind: "lifecycle_membership",
      payload: {
        requireCallCoverage,
        assignments: rows.flatMap((s) =>
          rowMembers(s).map((m) => ({
            allocation: m.allocation,
            lifecycleId: lifecycleOf(s),
            quantity: m.quantity,
          })),
        ),
      },
    });
    const withPlan = planned.suggestions.filter((s) => s.plan);
    const separates = withPlan.filter((s) => s.plan?.action === "separate");
    const connects = withPlan.filter((s) => s.plan?.action === "connect");
    expect(separates.length).toBeGreaterThan(0);
    expect(connects.length).toBeGreaterThan(0);
    const sep = decision(
      "sep",
      1,
      false,
      separates,
      (s) => s.plan?.lifecycleId ?? "",
    );
    const con = decision(
      "con",
      2,
      true,
      connects,
      (s) => s.plan?.lifecycleId ?? "",
    );
    // Decisions only throw under the live-check id, as the decision service uses.
    const live = (d: Decision): Decision => ({ ...d, id: "__validate__" });
    expect(() =>
      validateLifecycleDecision(c.ledger, c.projection, [], live(sep)),
    ).not.toThrow();
    expect(() =>
      validateLifecycleDecision(c.ledger, c.projection, [sep], live(con)),
    ).not.toThrow();
    // The check is not vacuous: connecting the held call as well is refused.
    const all = decision(
      "all",
      3,
      true,
      withPlan,
      (s) => s.plan?.lifecycleId ?? "",
    );
    expect(() =>
      validateLifecycleDecision(c.ledger, c.projection, [], live(all)),
    ).toThrow();
  });

  it("explains a call left open after the shares were sold", () => {
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "a",
        at(
          execution("a-open", call, "-1", "70", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "b",
        at(
          execution("b-open", callB, "-1", "60", 3, "open"),
          "2026-10-03T10:20:00Z",
        ),
      ],
      [
        "a",
        at(
          execution("a-close", call, "1", "-30", 3, "close"),
          "2026-10-03T10:24:00Z",
        ),
      ],
      [
        "shares",
        at(
          execution("sale", stock, "-100", "10500", 3, "close"),
          "2026-10-03T10:24:00Z",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "a-open")).toMatchObject({
      action: "connect",
      reason: "COVERED",
    });
    expect(planOf(planned, "b-open")).toMatchObject({
      action: "separate",
      reason: "SHARES_SOLD",
      sharesSold: { executionKey: "sale" },
      heldBy: refOf(lifecycles, "a-open"),
    });
  });

  it("explains an expiry-day roll", () => {
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "a",
        at(
          execution("a-open", call, "-1", "70", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "b",
        at(
          execution("b-open", callB, "-1", "60", 3, "open"),
          "2026-10-03T09:48:00Z",
        ),
      ],
      [
        "a",
        at(
          execution("a-exp", call, "1", "0", 3, "close", "expiry"),
          "2026-10-03T16:20:00Z",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "b-open")).toMatchObject({
      action: "connect",
      reason: "ROLL_RELEASE",
    });
  });

  it("explains a same-day legged roll", () => {
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "a",
        at(
          execution("a-open", call, "-1", "70", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "b",
        at(
          execution("b-open", callB, "-1", "60", 3, "open"),
          "2026-10-03T09:48:00Z",
        ),
      ],
      [
        "a",
        at(
          execution("a-close", call, "1", "-30", 3, "close"),
          "2026-10-03T10:27:00Z",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "b-open")).toMatchObject({
      action: "connect",
      reason: "ROLL_RELEASE",
    });
  });

  it("flags a call sold together with a long call as a spread leg", () => {
    const longCall = { ...call, key: "call-d", conid: "7" };
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "b",
        at(
          execution("b-open", callB, "-1", "60", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "d",
        at(
          execution("d-open", longCall, "1", "-20", 4, "open"),
          "2026-10-04T10:00:00Z",
        ),
      ],
      [
        "c",
        at(
          execution("c-open", callC, "-1", "50", 4, "open"),
          "2026-10-04T10:00:00Z",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "c-open")).toMatchObject({
      action: "separate",
      reason: "HELD_BY_EARLIER_CALL",
      pairedWith: { strategyId: "d", executionKey: "d-open", role: "open" },
    });
  });

  it("keeps dependsOn when a roll release also follows an earlier call", () => {
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "a",
        at(
          execution("a-open", call, "-1", "70", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "a",
        at(
          execution("a-close", call, "1", "-30", 3, "close"),
          "2026-10-03T09:00:00Z",
        ),
      ],
      [
        "b",
        at(
          execution("b-open", callB, "-1", "60", 3, "open"),
          "2026-10-03T09:30:00Z",
        ),
      ],
      [
        "c",
        at(
          execution("c-open", callC, "-1", "50", 3, "open"),
          "2026-10-03T10:00:00Z",
        ),
      ],
      [
        "b",
        at(
          execution("b-close", callB, "1", "-20", 3, "close"),
          "2026-10-03T10:30:00Z",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "c-open")).toMatchObject({
      action: "connect",
      reason: "ROLL_RELEASE",
      dependsOn: [refOf(lifecycles, "a-open")],
    });
  });

  it("asks for a choice when two share positions could cover a call", () => {
    const { ledger, projection } = fixture([
      ["s1", execution("s1-buy", stock, "100", "-10000", 1, "open")],
      ["s2", execution("s2-buy", stock, "100", "-10000", 1, "open")],
      ["s2", execution("s2-sell", stock, "-100", "10500", 5, "close")],
      [
        "a",
        at(
          execution("a-open", call, "-1", "70", 4, "open"),
          "2026-10-04T10:00:00Z",
        ),
      ],
      [
        "a",
        at(
          execution("a-close", call, "1", "-30", 4, "close"),
          "2026-10-04T15:00:00Z",
        ),
      ],
      [
        "b",
        at(
          execution("b-open", callB, "-1", "60", 6, "open"),
          "2026-10-06T10:00:00Z",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    expect(
      lifecycles.suggestions.find(
        (s) => s.callOpening.executionKey === "a-open",
      )?.candidateLifecycleIds,
    ).toHaveLength(2);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "a-open")).toMatchObject({
      action: "manual",
      reason: "MULTIPLE_POSITIONS",
      lifecycleId: null,
    });
    expect(planOf(planned, "b-open")).toMatchObject({
      action: "connect",
      dependsOn: [refOf(lifecycles, "a-open")],
    });
  });

  it("marks a row partial when only some of its fills fit", () => {
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "a",
        at(
          execution("a-open-1", call, "-1", "70", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "a",
        at(
          execution("a-open-2", call, "-1", "70", 2, "open"),
          "2026-10-02T11:00:00Z",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "a-open-1")).toMatchObject({
      action: "manual",
      reason: "PARTIAL",
    });
    expect(planOf(planned, "a-open-2")).toMatchObject({
      action: "manual",
      reason: "PARTIAL",
    });
  });

  it("asks for review when trade order is unknown", () => {
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "a",
        at(
          execution("a-open", call, "-1", "70", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "a",
        at(
          execution("a-close", call, "1", "-30", 3, "close"),
          "2026-10-03T10:00:00Z",
        ),
      ],
      [
        "b",
        at(execution("b-open", callB, "-1", "60", 3, "open"), "2026-10-03"),
      ],
    ]);
    const lifecycles = projectLifecycles(ledger, projection, []);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [],
      lifecycles,
    });
    expect(planOf(planned, "b-open")).toMatchObject({
      action: "manual",
      reason: "ORDER_UNKNOWN",
    });
  });

  it("recommends separate for a call already blocked by saved connections", () => {
    const { ledger, projection } = fixture([
      ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
      [
        "a",
        at(
          execution("a-open", call, "-1", "70", 2, "open"),
          "2026-10-02T10:00:00Z",
        ),
      ],
      [
        "b",
        at(
          execution("b-open", callB, "-1", "60", 3, "open"),
          "2026-10-03T10:00:00Z",
        ),
      ],
    ]);
    const initial = projectLifecycles(ledger, projection, []);
    const target = initial.suggestions[0]?.candidateLifecycleIds[0];
    if (!target) throw Error("missing share lifecycle");
    const saved: Decision = {
      id: "connect-a",
      sequence: 1,
      sources: [],
      strategyIds: [],
      supersedesId: null,
      kind: "lifecycle_membership",
      payload: {
        requireCallCoverage: true,
        assignments: initial.members
          .filter((m) => m.allocation.strategyId === "a")
          .map((m) => ({
            allocation: m.allocation,
            lifecycleId: target,
            quantity: m.quantity,
          })),
      },
    };
    const lifecycles = projectLifecycles(ledger, projection, [saved]);
    const row = lifecycles.suggestions.find(
      (s) => s.callOpening.executionKey === "b-open",
    );
    expect(row?.reasons).toContain("SHARES_RESERVED_BY_OTHER_CALLS");
    expect(row?.candidateLifecycleIds).toEqual([]);
    const planned = planConnections({
      ledger,
      projection,
      decisions: [saved],
      lifecycles,
    });
    expect(planOf(planned, "b-open")).toMatchObject({
      action: "separate",
      reason: "HELD_BY_EARLIER_CALL",
      lifecycleId: target,
      heldBy: {
        strategyId: "a",
        executionKey: "a-open",
        role: "open",
      },
    });
  });

  it("does not mutate its input", () => {
    const c = chain();
    const planned = planConnections(c);
    expect(planned).not.toBe(c.lifecycles);
    expect(c.lifecycles.suggestions.every((s) => s.plan === undefined)).toBe(
      true,
    );
    expect(planned.suggestions.some((s) => s.plan)).toBe(true);
  });
});

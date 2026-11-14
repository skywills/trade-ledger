import { describe, expect, it } from "vitest";
import { planConnections } from "../../src/server/lifecycles/connection-plan.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { validateLifecycleDecision } from "../../src/server/lifecycles/validate-decision.js";
import type { Decision, Execution } from "../../src/shared/domain.js";
import type { LifecycleProjection } from "../../src/shared/lifecycles.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

/**
 * Reduced from sample_data/2025.csv (HIMS). Two share lots are held together;
 * which lot a call belongs to is decided by the share sale it closed with,
 * matched FIFO on that sale's trade date, as IBKR does:
 * - Feb lot (02/27) is sold 05/16 in one combo order with the 30.5C buy-back.
 * - Apr lot (04/17) is called away 06/20 by the 60C assignment.
 * Between 04/21 and 05/06 the account holds 200 shares against two calls
 * (35C and 30.5C), both of which sit on the Feb lot by that evidence.
 */
function hims() {
  let row = 0;
  const at = (
    key: string,
    instrument: typeof stock,
    quantity: string,
    stamp: string,
    action: "open" | "close",
    event: Execution["event"] = "trade",
  ): Execution => {
    const [date = "", time = "12:00:00"] = stamp.split(" ");
    return {
      ...execution(key, instrument, quantity, "0", 1, action, event),
      date,
      rawDateTime: `${date}T${time}`,
      timezone: "America/New_York",
      sources: [{ importId: "imp", rowNumber: ++row }],
    };
  };
  const c35 = {
    ...call,
    key: "35c",
    conid: "35",
    strike: "35",
    expiry: "2025-05-16",
  };
  const c30 = { ...c35, key: "30.5c", conid: "305", strike: "30.5" };
  const c50 = {
    ...call,
    key: "50c",
    conid: "50",
    strike: "50",
    expiry: "2025-06-20",
  };
  const c42 = { ...c50, key: "42c", conid: "42", strike: "42" };
  const c60 = { ...c50, key: "60c", conid: "60", strike: "60" };
  const aprSale = at(
    "apr-sale",
    stock,
    "-100",
    "2025-06-20 16:20:00",
    "close",
    "assignment",
  );
  const c60Assign = at(
    "60-close",
    c60,
    "1",
    "2025-06-20 16:20:00",
    "close",
    "assignment",
  );
  const f = fixture(
    [
      ["feb", at("feb-buy", stock, "100", "2025-02-27 16:20:00", "open")],
      ["feb", at("feb-sale", stock, "-100", "2025-05-16 11:01:38", "close")],
      ["apr", at("apr-buy", stock, "100", "2025-04-17 16:20:00", "open")],
      ["apr", aprSale],
      ["35", at("35-open", c35, "-1", "2025-04-16 10:48:41", "open")],
      ["35", at("35-close", c35, "1", "2025-05-06 10:45:57", "close")],
      ["30", at("30-open", c30, "-1", "2025-04-21 09:32:30", "open")],
      ["30", at("30-close", c30, "1", "2025-05-16 11:01:38", "close")],
      ["50", at("50-open", c50, "-1", "2025-05-05 11:33:39", "open")],
      ["50", at("50-close", c50, "1", "2025-05-06 10:46:34", "close")],
      ["42", at("42-open", c42, "1", "2025-05-05 11:33:39", "open")],
      ["42", at("42-close", c42, "-1", "2025-05-06 10:46:34", "close")],
      ["60", at("60-open", c60, "-1", "2025-05-06 10:45:57", "open")],
      ["60", c60Assign],
    ],
    [
      {
        from: "60",
        to: "apr",
        type: "assignment",
        sources: [...c60Assign.sources, ...aprSale.sources],
      },
    ],
  );
  const lifecycles = projectLifecycles(f.ledger, f.projection, []);
  const lot = (key: string) => {
    const id = lifecycles.members.find(
      (m) => m.allocation.executionKey === key,
    )?.lifecycleId;
    if (!id) throw new Error(`No lifecycle holds ${key}`);
    return id;
  };
  return { ...f, lifecycles, feb: lot("feb-buy"), apr: lot("apr-buy") };
}

type Hims = ReturnType<typeof hims>;

function plans(c: Hims, lifecycles: LifecycleProjection = c.lifecycles) {
  const planned = planConnections({ ...c, decisions: [], lifecycles });
  return (key: string) =>
    planned.suggestions.find((s) => s.callOpening.executionKey === key)?.plan;
}

/** A saved connection of one call strategy, as connectionProposal builds it. */
function connect(
  c: Hims,
  strategyId: string,
  lifecycleId: string | null,
  sequence: number,
  id = `d${sequence}`,
): Decision {
  // null keeps each member in its own lifecycle, as "Keep separate" saves it.
  return {
    id,
    sequence,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    kind: "lifecycle_membership",
    payload: {
      requireCallCoverage: lifecycleId !== null,
      assignments: c.lifecycles.members
        .filter((m) => m.allocation.strategyId === strategyId)
        .map((m) => ({
          allocation: m.allocation,
          quantity: m.quantity,
          lifecycleId: lifecycleId ?? m.lifecycleId,
        })),
    },
  };
}

const ownerOf = (p: LifecycleProjection, key: string) =>
  p.members
    .filter((m) => m.allocation.executionKey === key)
    .map((m) => m.lifecycleId);

describe("HIMS: calls follow the FIFO lot of the share sale they closed with", () => {
  it("places each share sale on its IBKR FIFO lot before any connection", () => {
    const c = hims();
    expect(ownerOf(c.lifecycles, "feb-sale")).toEqual([c.feb]);
    expect(ownerOf(c.lifecycles, "apr-sale")).toEqual([c.apr]);
  });

  it("recommends the 30.5C on the Feb lot and the 60C on the Apr lot", () => {
    const c = hims();
    const plan = plans(c);
    expect(plan("35-open")).toMatchObject({
      action: "connect",
      lifecycleId: c.feb,
    });
    expect(plan("30-open")).toMatchObject({
      action: "connect",
      lifecycleId: c.feb,
    });
    expect(plan("60-open")).toMatchObject({
      action: "connect",
      lifecycleId: c.apr,
    });
    expect(plan("50-open")).toMatchObject({
      action: "separate",
      pairedWith: { executionKey: "42-open" },
    });
  });

  it("saves the recommended connections and keeps the IBKR tax lots", () => {
    const c = hims();
    const decisions: Decision[] = [];
    // In opening order, as Apply recommended saves them.
    const steps: Array<[string, string | null]> = [
      ["35", c.feb],
      ["30", c.feb],
      ["50", null],
      ["60", c.apr],
    ];
    steps.forEach(([strategy, target], i) => {
      const live = connect(c, strategy, target, i + 1, "__validate__");
      expect(() =>
        validateLifecycleDecision(c.ledger, c.projection, decisions, live),
      ).not.toThrow();
      decisions.push(connect(c, strategy, target, i + 1));
    });
    const after = projectLifecycles(c.ledger, c.projection, decisions);
    expect(ownerOf(after, "feb-sale")).toEqual([c.feb]);
    expect(ownerOf(after, "apr-sale")).toEqual([c.apr]);
    expect(ownerOf(after, "30-close")).toEqual([c.feb]);
    expect(ownerOf(after, "60-close")).toEqual([c.apr]);
    expect(after.issues.map((i) => i.code)).not.toContain(
      "LIFECYCLE_DECISION_UNRESOLVED",
    );
    for (const l of after.lifecycles)
      expect(l.reasons).not.toContain("IBKR_TAX_LOT_DIFFERS");
  });

  it("does not depend on the input order of suggestions", () => {
    const c = hims();
    const reversed = plans(c, {
      ...c.lifecycles,
      suggestions: [...c.lifecycles.suggestions].reverse(),
    });
    const forward = plans(c);
    for (const key of ["35-open", "30-open", "50-open", "60-open"])
      expect(reversed(key)).toEqual(forward(key));
  });
});

describe("call coverage across share lots of one underlying", () => {
  it("rejects a third call when both lots are already covered", () => {
    const c = hims();
    const extra = fixture([
      [
        "x",
        {
          ...execution(
            "x-open",
            { ...call, key: "xc", conid: "77" },
            "-1",
            "0",
            1,
            "open",
          ),
          date: "2025-04-22",
          rawDateTime: "2025-04-22T10:00:00",
          timezone: "America/New_York",
          sources: [{ importId: "imp", rowNumber: 900 }],
        },
      ],
    ]);
    c.ledger.executions.push(...extra.ledger.executions);
    c.projection.allocations.push(...extra.projection.allocations);
    c.projection.strategies.push(...extra.projection.strategies);
    const lifecycles = projectLifecycles(c.ledger, c.projection, []);
    const withX = { ...c, lifecycles };
    // 35C and 30.5C already use all 200 shares across both lots, so a third
    // call cannot be covered by the Apr lot even though Apr holds no call.
    const saved = [
      connect(withX, "35", c.feb, 1),
      connect(withX, "30", c.feb, 2),
    ];
    expect(() =>
      validateLifecycleDecision(
        c.ledger,
        c.projection,
        saved,
        connect(withX, "x", c.apr, 3, "__validate__"),
      ),
    ).toThrow(
      expect.objectContaining({ code: "INVALID_LIFECYCLE_MEMBERSHIP" }),
    );
  });
});

describe("which share sale decides a call's lot", () => {
  /**
   * Lots A and B; a 1-contract call bought back at the same instant as a
   * 100-share sale from lot B. `bOpen` is when lot B was bought.
   */
  function twoLots(saleCombo: string, bOpen = 2) {
    // IBKR combo legs have separate order ids; their exec ids share a prefix.
    const withOrder = (
      e: Execution,
      combo: string,
      leg: string,
    ): Execution => ({
      ...e,
      brokerIds: { IBOrderID: `${leg}-order`, IBExecID: `${combo}.${leg}.01` },
    });
    const f = fixture([
      ["a", execution("a-buy", stock, "100", "-100", 1, "open")],
      ["b", execution("b-buy", stock, "100", "-100", bOpen, "open")],
      ["c", execution("c-open", call, "-1", "50", 3, "open")],
      [
        "c",
        withOrder(
          execution("c-close", call, "1", "-60", 5, "close"),
          "0000f942.aa",
          "02",
        ),
      ],
      [
        "b",
        withOrder(
          execution("b-sale", stock, "-100", "110", 5, "close"),
          saleCombo,
          "03",
        ),
      ],
    ]);
    const lifecycles = projectLifecycles(f.ledger, f.projection, []);
    const lot = (key: string) =>
      lifecycles.members.find((m) => m.allocation.executionKey === key)
        ?.lifecycleId;
    const plan = planConnections({ ...f, decisions: [], lifecycles })
      .suggestions[0]?.plan;
    return { plan, a: lot("a-buy"), b: lot("b-buy") };
  }

  it("pins the call to the lot sold in the same combo", () => {
    const c = twoLots("0000f942.aa");
    expect(c.plan).toMatchObject({ action: "connect", lifecycleId: c.b });
  });

  it("ignores an unrelated sale that only shares the timestamp", () => {
    expect(twoLots("0000f942.bb").plan).toMatchObject({
      action: "manual",
      reason: "MULTIPLE_POSITIONS",
    });
  });

  it("ignores a sold lot that was bought after the call opened", () => {
    const c = twoLots("0000f942.aa", 4);
    expect(c.plan).toMatchObject({ action: "connect", lifecycleId: c.a });
  });
});

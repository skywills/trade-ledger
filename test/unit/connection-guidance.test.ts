import { expect, it } from "vitest";
import type {
  AllocationRef,
  ConnectionPlan,
} from "../../src/shared/lifecycles.js";
import type { Execution } from "../../src/web/api.js";
import type { ConnectionData } from "../../src/web/lifecycles/connection-batch.js";
import { connectionSections } from "../../src/web/lifecycles/connection-batch.js";
import {
  contractLabel,
  explainPlan,
  groupPlan,
  positionGroups,
} from "../../src/web/lifecycles/connection-guidance.js";

const instrument = (
  key: string,
  expiry: string | null,
  strike: string | null,
  putCall: "P" | "C" | null,
): Execution["instrument"] => ({
  key,
  assetClass: putCall ? "OPT" : "STK",
  symbol: "NVDA",
  underlying: "NVDA",
  conid: key,
  expiry,
  strike,
  putCall,
  multiplier: putCall ? "100" : null,
});

function exec(
  key: string,
  inst: Execution["instrument"],
  date: string,
  time: string,
  quantity: string,
  event: Execution["event"] = "trade",
): Execution {
  return {
    key,
    instrument: inst,
    quantity,
    netCash: "0",
    date,
    rawDateTime: `${date}T${time}:00`,
    timezone: null,
    account: "A",
    currency: "USD",
    price: null,
    proceeds: null,
    commission: null,
    taxes: null,
    basis: null,
    brokerPnl: null,
    action: "open",
    event,
    brokerIds: {},
    codes: [],
    sources: [],
  };
}

const ref = (executionKey: string): AllocationRef => ({
  strategyId: `s-${executionKey}`,
  executionKey,
  role: "open",
});

const callA = instrument("ca", "2026-01-16", "190", "C");
const callB = instrument("cb", "2026-01-16", "195.0", "C");
const callC = instrument("cc", "2025-11-07", "64", "C");
const callD = instrument("cd", "2025-05-23", "110", "C");
const callE = instrument("ce", "2026-01-16", "197.5", "C");
const callNew = instrument("cn", "2026-02-20", "200", "C");
const stk = instrument("stk", null, null, null);

const executions = [
  exec("a", callA, "2025-12-22", "09:00", "-1"),
  exec("b", callB, "2025-12-01", "09:00", "-1"),
  exec("c", callC, "2025-11-07", "09:00", "-1"),
  exec("d", callD, "2025-05-13", "09:00", "-1"),
  exec("e", callE, "2025-12-22", "10:37", "1"),
  exec("new", callNew, "2025-12-22", "10:37", "-1"),
  exec("sale", stk, "2025-05-13", "10:24", "-100"),
  exec("asg1", stk, "2025-04-17", "16:00", "100", "assignment"),
  exec("n1", callNew, "2025-12-22", "10:37", "-1"),
];

function member(lifecycleId: string, executionKey: string, quantity = "-1") {
  return {
    lifecycleId,
    allocation: ref(executionKey),
    quantity,
    netCash: "0",
    brokerPnl: null,
    estimated: false,
    sources: [],
  };
}

function lifecycle(id: string, description: string) {
  return {
    id,
    description,
    underlyingKey: "value:NVDA",
    openingDate: "2025-04-17",
  };
}

function suggestion(id: string, key: string, plan?: ConnectionPlan) {
  return {
    id,
    callOpening: {
      strategyId: `s-${key}`,
      executionKey: key,
      role: "open" as const,
    },
    candidateLifecycleIds: ["L1", "L2"],
    quantity: "-1",
    sources: [],
    reasons: [],
    ...(plan ? { plan } : {}),
  };
}

function build(plans: Array<[string, string, ConnectionPlan | undefined]>) {
  const keys = plans.map(([, k]) => k);
  return {
    buildId: "b",
    ledgerId: "l",
    stale: false,
    watermark: 1,
    generatedAt: "",
    rebuildRequired: false,
    connectionExecutions: executions,
    lifecycles: {
      version: 1,
      lifecycles: [
        lifecycle("L1", "NVDA Apr17'25 109 Short Put"),
        lifecycle("L2", "NVDA May1'25 100 Short Put"),
      ],
      members: [
        ...keys.map((k) => member("L1", k)),
        member("L1", "asg1", "100"),
      ],
      campaigns: [],
      suggestions: plans.map(([id, k, p]) => suggestion(id, k, p)),
      issues: [],
      valuations: [],
    },
  } as unknown as ConnectionData;
}

const plan = (
  p: Partial<ConnectionPlan> & Pick<ConnectionPlan, "action" | "reason">,
) => ({ lifecycleId: "L1", ...p }) as ConnectionPlan;

it("formats contract labels", () => {
  expect(contractLabel(callA)).toBe("Jan16'26 190C");
  expect(contractLabel(callB)).toBe("Jan16'26 195C");
  expect(contractLabel(callE)).toBe("Jan16'26 197.5C");
  expect(contractLabel(instrument("x", "2025-06-20", "145", "C"))).toBe(
    "Jun20'25 145C",
  );
});

it("groups rows by position with needs-choice last", () => {
  const covered = plan({
    action: "connect",
    reason: "COVERED",
    sharesAtOpening: "100",
  });
  const separate = plan({ action: "separate", reason: "HELD_BY_EARLIER_CALL" });
  const manual = plan({ action: "manual", reason: "PARTIAL" });
  const choice = plan({
    action: "manual",
    reason: "MULTIPLE_POSITIONS",
    lifecycleId: null,
  });
  const other = plan({
    action: "connect",
    reason: "COVERED",
    lifecycleId: "L2",
  });
  const data = build([
    ["s1", "a", choice],
    ["s2", "d", manual],
    ["s3", "c", covered],
    ["s4", "b", separate],
    ["s5", "e", other],
  ]);
  const [section] = connectionSections(data);
  if (!section) throw new Error("no section");
  const groups = positionGroups(section, data);
  expect(groups.map((g) => g.lifecycleId)).toEqual(["L1", "L2", null]);
  const l1 = groups[0];
  expect(l1?.title).toBe(
    "100 shares from NVDA Apr17'25 109 Short Put (assigned 2025-04-17)",
  );
  expect(l1?.groups).toHaveLength(3);
  expect(l1?.applicable.connect).toHaveLength(1);
  expect(l1?.applicable.separate).toHaveLength(1);
  expect(l1?.blockedBy && groupPlan(l1.blockedBy)?.action).toBe("manual");
  expect(groups[1]?.blockedBy).toBeNull();
  expect(groups[2]?.applicable).toEqual({ connect: [], separate: [] });
});

it("returns one needs-choice group without plans", () => {
  const data = build([["s1", "a", undefined]]);
  const [section] = connectionSections(data);
  if (!section) throw new Error("no section");
  const groups = positionGroups(section, data);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.lifecycleId).toBeNull();
  expect(groups[0]?.applicable).toEqual({ connect: [], separate: [] });
  expect(groups[0]?.blockedBy).toBeNull();
  expect(groupPlan(groups[0]?.groups[0] as never)).toBeNull();
});

const p2 = (p: ConnectionPlan, key: string) => {
  const data = build([["s1", key, p]]);
  return {
    data,
    plan: data.lifecycles?.suggestions[0]?.plan as ConnectionPlan,
  };
};

it("explains plans", () => {
  let c = p2(
    plan({ action: "connect", reason: "COVERED", sharesAtOpening: "100" }),
    "a",
  );
  expect(explainPlan(c.plan, c.data)).toBe(
    "100 shares were free when this call was sold.",
  );
  c = p2(
    plan({
      action: "connect",
      reason: "COVERED_AFTER_EARLIER",
      dependsOn: [ref("b")],
    }),
    "a",
  );
  expect(explainPlan(c.plan, c.data)).toBe(
    "Rolled from the Jan16'26 195C; covered once that call is connected.",
  );
  c = p2(
    plan({ action: "connect", reason: "ROLL_RELEASE", heldBy: ref("c") }),
    "a",
  );
  expect(explainPlan(c.plan, c.data)).toBe(
    "Sold before the Nov7'25 64C closed later that day; the shares passed to this call.",
  );
  c = p2(
    plan({
      action: "separate",
      reason: "HELD_BY_EARLIER_CALL",
      heldBy: ref("a"),
    }),
    "new",
  );
  expect(explainPlan(c.plan, c.data)).toBe(
    "When this call was sold (2025-12-22 10:37), the Jan16'26 190C still held the shares.",
  );
  c = p2(
    plan({
      action: "separate",
      reason: "SHARES_SOLD",
      heldBy: ref("d"),
      sharesSold: { executionKey: "sale" },
    }),
    "d",
  );
  const sold = c.data.connectionExecutions.find((e) => e.key === "d");
  if (sold) sold.rawDateTime = "2025-05-13T10:20:00";
  expect(explainPlan(c.plan, c.data)).toBe(
    "When this call was sold (2025-05-13 10:20), the May23'25 110C still held the shares. The shares were sold at 10:24 the same day, so they never covered this call.",
  );
  c = p2(
    plan({
      action: "separate",
      reason: "HELD_BY_EARLIER_CALL",
      heldBy: ref("a"),
      pairedWith: ref("e"),
    }),
    "new",
  );
  expect(explainPlan(c.plan, c.data)).toContain(
    " Sold together with a long Jan16'26 197.5C — likely a call spread.",
  );
  c = p2(
    plan({ action: "manual", reason: "MULTIPLE_POSITIONS", lifecycleId: null }),
    "a",
  );
  expect(explainPlan(c.plan, c.data)).toBe(
    "More than one share position could cover this call. Choose one.",
  );
  c = p2(plan({ action: "manual", reason: "PARTIAL" }), "a");
  expect(explainPlan(c.plan, c.data)).toBe(
    "Only some of these contracts can be covered. Review this call individually.",
  );
  c = p2(plan({ action: "manual", reason: "ORDER_UNKNOWN" }), "a");
  expect(explainPlan(c.plan, c.data)).toBe(
    "Trade times can't show what happened first. Review this call individually.",
  );
});

import { describe, expect, it } from "vitest";
import { redirectLifecycleDecisions } from "../../src/server/lifecycles/aliases.js";
import {
  projectLifecycles,
  validateMembership,
} from "../../src/server/lifecycles/project.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type { Decision } from "../../src/shared/domain.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

const ids = ({ openingExecutionKey }: { openingExecutionKey: string }) =>
  openingExecutionKey;
function spread() {
  const short = { ...call, key: "short", conid: "101", strike: "100" };
  const long = { ...call, key: "long", conid: "102", strike: "105" };
  const rows: Parameters<typeof fixture>[0] = [
    ["short", execution("short-open", short, "-1", "300", 1, "open")],
    [
      "short",
      execution("short-close", short, "1", "0", 2, "close", "assignment"),
    ],
    ["long", execution("long-open", long, "1", "-100", 1, "open")],
    ["long", execution("long-close", long, "-1", "0", 2, "close", "exercise")],
    [
      "stock",
      execution("stock-open", stock, "-100", "10000", 2, "open", "assignment"),
    ],
    [
      "stock",
      execution("stock-close", stock, "100", "-10500", 2, "close", "exercise"),
    ],
  ];
  rows.forEach(([, e], i) => {
    e.sources = [{ importId: "imp", rowNumber: i + 2 }];
  });
  const byKey = new Map(rows.map(([, e]) => [e.key, e]));
  for (const [optionKey, stockKey, action] of [
    ["short-close", "stock-open", "assign"],
    ["long-close", "stock-close", "exercise"],
  ]) {
    const option = byKey.get(optionKey ?? "");
    const delivery = byKey.get(stockKey ?? "");
    if (!option || !delivery || !action)
      throw new Error("Missing fixture event");
    option.brokerIds.PositionActionID = delivery.brokerIds.PositionActionID =
      action;
  }
  const f = fixture(rows);
  f.projection = groupStrategies(
    f.ledger,
    [],
    (account, keys) => `${account}:${keys.join(",")}`,
  );
  return f;
}
function campaign(id: string, sequence: number): Decision {
  return {
    id: `create-${id}`,
    sequence,
    kind: "wheel_campaign",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      campaignId: id,
      name: id,
      account: "A",
      currency: "USD",
      underlyingKey: "value:XYZ",
    },
  };
}
function membership(
  lifecycleId: string,
  campaignId: string | null,
  sequence: number,
): Decision {
  return {
    id: `member-${sequence}`,
    sequence,
    kind: "wheel_campaign_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: { lifecycleId, campaignId },
  };
}
const anchors = [
  { account: "A", openingExecutionKey: "short-open", id: "retained-short" },
  { account: "A", openingExecutionKey: "long-open", id: "retained-long" },
];

describe("retained lifecycle references after an exercise join", () => {
  it("keeps the absorbed lifecycle's saved campaign on the surviving lifecycle", () => {
    const f = spread();
    const decisions = [
      campaign("wheel", 1),
      membership("retained-long", "wheel", 2),
    ];
    const p = projectLifecycles(
      f.ledger,
      f.projection,
      decisions,
      ids,
      undefined,
      anchors,
    );
    expect(p.lifecycles).toHaveLength(1);
    expect(p.lifecycles[0]).toMatchObject({
      id: "retained-short",
      campaignId: "wheel",
      status: "closed",
    });
    expect(p.campaigns[0]?.lifecycleIds).toEqual(["retained-short"]);
    expect(p.issues).toEqual([]);
    expect(decisions[1]?.payload.lifecycleId).toBe("retained-long");
    expect(validateMembership(f.ledger, f.projection, p.members)).toEqual([]);
  });
  it("coalesces matching campaign assignments from both former lifecycles", () => {
    const f = spread();
    const p = projectLifecycles(
      f.ledger,
      f.projection,
      [
        campaign("wheel", 1),
        membership("retained-long", "wheel", 2),
        membership("retained-short", "wheel", 3),
      ],
      ids,
      undefined,
      anchors,
    );
    expect(p.lifecycles[0]?.campaignId).toBe("wheel");
    expect(p.campaigns[0]?.lifecycleIds).toEqual(["retained-short"]);
    expect(p.issues).toEqual([]);
  });
  it("surfaces conflicting saved campaigns instead of choosing by decision order", () => {
    const f = spread();
    const p = projectLifecycles(
      f.ledger,
      f.projection,
      [
        campaign("one", 1),
        campaign("two", 2),
        membership("retained-long", "one", 3),
        membership("retained-short", "two", 4),
      ],
      ids,
      undefined,
      anchors,
    );
    expect(p.lifecycles[0]).toMatchObject({
      id: "retained-short",
      campaignId: null,
      status: "unresolved",
      complete: false,
    });
    expect(p.campaigns.map((c) => c.lifecycleIds)).toEqual([[], []]);
    expect(p.issues.map((i) => i.code)).toContain(
      "LIFECYCLE_CAMPAIGN_CONFLICT",
    );
  });
});

it("does not merge independent cycles when partial exercises deliver to different stock owners", () => {
  const shortA = { ...call, key: "call-a", conid: "101" };
  const shortB = { ...call, key: "call-b", conid: "102" };
  const long = { ...call, key: "long", conid: "103" };
  const rows: Parameters<typeof fixture>[0] = [
    ["a", execution("a-open", shortA, "-1", "300", 1, "open")],
    ["a", execution("a-assign", shortA, "1", "0", 2, "close", "assignment")],
    ["b", execution("b-open", shortB, "-1", "300", 1, "open")],
    ["b", execution("b-assign", shortB, "1", "0", 4, "close", "assignment")],
    ["long", execution("long-open", long, "2", "-200", 1, "open")],
    ["long", execution("exercise-a", long, "-1", "0", 3, "close", "exercise")],
    ["long", execution("exercise-b", long, "-1", "0", 5, "close", "exercise")],
    [
      "stock",
      execution("stock-a", stock, "-100", "10000", 2, "open", "assignment"),
    ],
    [
      "stock",
      execution("close-a", stock, "100", "-10500", 3, "close", "exercise"),
    ],
    [
      "stock",
      execution("stock-b", stock, "-100", "10000", 4, "open", "assignment"),
    ],
    [
      "stock",
      execution("close-b", stock, "100", "-10500", 5, "close", "exercise"),
    ],
  ];
  rows.forEach(([, e], i) => {
    e.sources = [{ importId: "imp", rowNumber: i + 2 }];
  });
  const byKey = new Map(rows.map(([, e]) => [e.key, e]));
  for (const [a, b] of [
    ["a-assign", "stock-a"],
    ["b-assign", "stock-b"],
    ["exercise-a", "close-a"],
    ["exercise-b", "close-b"],
  ]) {
    const option = byKey.get(a ?? ""),
      delivery = byKey.get(b ?? "");
    if (!option || !delivery || !a) throw new Error("Missing fixture event");
    option.brokerIds.PositionActionID = delivery.brokerIds.PositionActionID = a;
  }
  const f = fixture(rows);
  const grouped = groupStrategies(
    f.ledger,
    [],
    (account, keys) => `${account}:${keys.join(",")}`,
  );
  const p = projectLifecycles(f.ledger, grouped, [], ids);
  expect(p.lifecycles).toHaveLength(3);
  const owner = (key: string) =>
    p.members.find((m) => m.allocation.executionKey === key)?.lifecycleId;
  expect(owner("a-open")).not.toBe(owner("b-open"));
  expect(owner("stock-a")).toBe(owner("a-open"));
  expect(owner("stock-b")).toBe(owner("b-open"));
  expect(p.lifecycles.find((l) => l.id === "long-open")?.status).toBe(
    "unresolved",
  );
  expect(p.issues.map((i) => i.code)).toContain(
    "LIFECYCLE_OPTION_CLOSE_AMBIGUOUS",
  );
  expect(validateMembership(f.ledger, grouped, p.members)).toEqual([]);
});

it("coalesces retained quantity partitions whose lifecycle targets combine", () => {
  const f = spread();
  f.ledger.executions.push(
    execution("extra-shares", stock, "200", "-20000", 1, "open"),
  );
  f.projection = groupStrategies(
    f.ledger,
    [],
    (account, keys) => `${account}:${keys.join(",")}`,
  );
  const a = f.projection.allocations.find(
    (a) => a.executionKey === "extra-shares",
  );
  if (!a) throw new Error("Expected stock allocation");
  const allocation = {
    strategyId: a.strategyId,
    executionKey: a.executionKey,
    role: a.role,
  };
  const correction: Decision = {
    id: "partition",
    sequence: 1,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      assignments: [
        { allocation, lifecycleId: "retained-long", quantity: "100" },
        { allocation, lifecycleId: "retained-short", quantity: "100" },
      ],
    },
  };
  const p = projectLifecycles(
    f.ledger,
    f.projection,
    [correction],
    ids,
    undefined,
    anchors,
  );
  expect(p.issues).toEqual([]);
  expect(
    p.members
      .filter((m) => m.allocation.executionKey === "extra-shares")
      .map((m) => ({ owner: m.lifecycleId, quantity: m.quantity })),
  ).toEqual([{ owner: "retained-short", quantity: "200" }]);
  expect(validateMembership(f.ledger, f.projection, p.members)).toEqual([]);
});

it("coalesces covered-call target quantities across chained lifecycle aliases", () => {
  const d: Decision = {
    id: "attachment",
    sequence: 1,
    kind: "lifecycle_attachment",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      opening: { strategyId: "call", executionKey: "call-open", role: "open" },
      targets: [
        { lifecycleId: "oldest", quantity: "-1" },
        { lifecycleId: "middle", quantity: "-2" },
      ],
    },
  };
  const redirected = redirectLifecycleDecisions(
    [d],
    new Map([
      ["oldest", "middle"],
      ["middle", "survivor"],
    ]),
  );
  expect(redirected.decisions[0]?.payload.targets).toEqual([
    { lifecycleId: "survivor", quantity: "-3" },
  ]);
  expect(d.payload.targets).toEqual([
    { lifecycleId: "oldest", quantity: "-1" },
    { lifecycleId: "middle", quantity: "-2" },
  ]);
});

it("preserves an explicit later campaign removal for the absorbed lifecycle", () => {
  const f = spread();
  const p = projectLifecycles(
    f.ledger,
    f.projection,
    [
      campaign("wheel", 1),
      membership("retained-long", "wheel", 2),
      membership("retained-long", null, 3),
    ],
    ids,
    undefined,
    anchors,
  );
  expect(p.lifecycles[0]?.campaignId).toBeNull();
  expect(p.campaigns[0]?.lifecycleIds).toEqual([]);
  expect(p.issues).toEqual([]);
});

it.each([false, true])(
  "keeps a fully evidenced assignment/exercise chain resolved (reverse=%s)",
  (reverse) => {
    const ca = { ...call, key: "call-a", conid: "101" };
    const cb = { ...call, key: "call-b", conid: "102" };
    const long = { ...call, key: "long", conid: "103" };
    const otherLong = { ...call, key: "other-long", conid: "104" };
    const rows: Parameters<typeof fixture>[0] = [
      ["a", execution("a-open", ca, "-1", "300", 1, "open")],
      ["a", execution("a-assign", ca, "1", "0", 2, "close", "assignment")],
      ["b", execution("b-open", cb, "-1", "300", 1, "open")],
      ["b", execution("b-assign", cb, "1", "0", 4, "close", "assignment")],
      ["long", execution("long-open", long, "1", "-100", 1, "open")],
      [
        "long",
        execution("exercise-a", long, "-1", "0", 3, "close", "exercise"),
      ],
      ["a", execution("other-long-open", otherLong, "1", "-100", 1, "open")],
      [
        "a",
        execution("exercise-b", otherLong, "-1", "0", 5, "close", "exercise"),
      ],
      [
        "stock",
        execution("stock-a", stock, "-100", "10000", 2, "open", "assignment"),
      ],
      [
        "stock",
        execution("close-a", stock, "100", "-10500", 3, "close", "exercise"),
      ],
      [
        "stock",
        execution("stock-b", stock, "-100", "10000", 4, "open", "assignment"),
      ],
      [
        "stock",
        execution("close-b", stock, "100", "-10500", 5, "close", "exercise"),
      ],
    ];
    rows.forEach(([, e], i) => {
      e.sources = [{ importId: "imp", rowNumber: i + 2 }];
    });
    const byKey = new Map(rows.map(([, e]) => [e.key, e]));
    const links = [
      ["a", "a-assign", "stock-a", "assignment"],
      ["b", "b-assign", "stock-b", "assignment"],
      ["long", "exercise-a", "close-a", "exercise"],
      ["a", "exercise-b", "close-b", "exercise"],
    ].map(([from, optionKey, stockKey, type]) => {
      const option = byKey.get(optionKey ?? ""),
        delivery = byKey.get(stockKey ?? "");
      if (!option || !delivery || !optionKey || !from || !type)
        throw new Error("Missing chain event");
      option.brokerIds.PositionActionID = delivery.brokerIds.PositionActionID =
        optionKey;
      return {
        from,
        to: "stock",
        type,
        sources: [...option.sources, ...delivery.sources],
      };
    });
    const f = fixture(rows, reverse ? links.reverse() : links);
    const p = projectLifecycles(f.ledger, f.projection, [], ids);
    expect(p.lifecycles).toHaveLength(1);
    expect(p.lifecycles[0]).toMatchObject({
      id: "b-open",
      status: "closed",
      complete: true,
      cashflow: "-600",
    });
    expect(p.issues).toEqual([]);
    expect(validateMembership(f.ledger, f.projection, p.members)).toEqual([]);
  },
);

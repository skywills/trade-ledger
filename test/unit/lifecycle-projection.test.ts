import { describe, expect, it } from "vitest";
import { accountLifecycles } from "../../src/server/lifecycles/accounting.js";
import {
  projectLifecycles,
  validateMembership,
} from "../../src/server/lifecycles/project.js";
import {
  assigned,
  call,
  execution,
  fixture,
  protection,
  put,
  stock,
} from "../fixtures/lifecycles.js";

const ids = ({
  account,
  openingExecutionKey,
}: {
  account: string;
  openingExecutionKey: string;
}) => `${account}:${openingExecutionKey}`;
describe("trade lifecycles", () => {
  it("keeps assignment open and combines a later stock close once", () => {
    const held = assigned();
    const p = projectLifecycles(held.ledger, held.projection, [], ids);
    expect(p.lifecycles).toHaveLength(1);
    expect(p.lifecycles[0]?.status).toBe("open");
    expect(p.lifecycles[0]?.positions[0]?.quantity).toBe("100");
    const closed = assigned(true);
    const result = accountLifecycles(
      closed.ledger,
      closed.projection,
      projectLifecycles(closed.ledger, closed.projection, [], ids),
    );
    expect(result.lifecycles).toHaveLength(1);
    expect(result.lifecycles[0]).toMatchObject({
      status: "closed",
      reconstructedPnl: "-150",
      closeDate: "2026-10-08",
    });
    expect(
      validateMembership(closed.ledger, closed.projection, result.members),
    ).toEqual([]);
  });
  it("keeps the protective put open after stock disposal", () => {
    const f = assigned(true);
    f.ledger.executions.push(
      execution("protect", protection, "1", "-50", 1, "open"),
    );
    f.projection.allocations.push({
      strategyId: "put-origin",
      executionKey: "protect",
      quantity: "1",
      netCash: "-50",
      brokerPnl: null,
      pnlEstimated: false,
      role: "open",
    });
    const p = projectLifecycles(f.ledger, f.projection, [], ids);
    expect(p.lifecycles[0]?.status).toBe("open");
  });
  it("suggests calls only when shares exist before the opening", () => {
    const f = assigned();
    const c = fixture([
      ["calls", execution("c-open", call, "-1", "100", 3, "open")],
    ]);
    f.ledger.executions.push(...c.ledger.executions);
    f.projection.allocations.push(...c.projection.allocations);
    f.projection.strategies.push(...c.projection.strategies);
    const p = projectLifecycles(f.ledger, f.projection, [], ids);
    expect(p.suggestions).toHaveLength(1);
    expect(p.suggestions[0]?.candidateLifecycleIds).toEqual(["A:p-open"]);
  });
  it("leaves independent cycles distinct and conserves a shared close", () => {
    const f = fixture([
      ["one", execution("one-open", stock, "100", "-10000", 1, "open")],
      ["two", execution("two-open", stock, "50", "-5000", 2, "open")],
      ["one", execution("sale", stock, "-150", "16000", 4, "close")],
    ]);
    const p = projectLifecycles(f.ledger, f.projection, [], ids);
    expect(p.lifecycles.length).toBeGreaterThanOrEqual(2);
    expect(validateMembership(f.ledger, f.projection, p.members)).toEqual([]);
  });
});
it("attaches only the assigned stock opening when the stock component contains unrelated shares", () => {
  const f = assigned(true);
  const other = execution("unrelated", stock, "20", "-2000", 1, "open");
  f.ledger.executions.push(other);
  f.projection.allocations.push({
    strategyId: "stock-origin",
    executionKey: other.key,
    quantity: "20",
    netCash: "-2000",
    brokerPnl: null,
    pnlEstimated: false,
    role: "open",
  });
  const p = projectLifecycles(f.ledger, f.projection, [], ids);
  const origin = p.lifecycles.find((l) => l.originStrategyType === "short_put");
  expect(
    p.members.find((m) => m.allocation.executionKey === "s-buy")?.lifecycleId,
  ).toBe(origin?.id);
  expect(
    p.members.find((m) => m.allocation.executionKey === "unrelated")
      ?.lifecycleId,
  ).not.toBe(origin?.id);
  expect(validateMembership(f.ledger, f.projection, p.members)).toEqual([]);
});
it("rejects two overlapping attachments that reserve the same shares", () => {
  const f = assigned();
  const rows = fixture([
    ["c1", execution("co1", call, "-1", "100", 3, "open")],
    ["c2", execution("co2", call, "-1", "100", 4, "open")],
  ]);
  f.ledger.executions.push(...rows.ledger.executions);
  f.projection.allocations.push(...rows.projection.allocations);
  f.projection.strategies.push(...rows.projection.strategies);
  const decisions = ["co1", "co2"].map((key, i) => ({
    id: "__validate__",
    sequence: i + 1,
    kind: "lifecycle_attachment",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      opening: {
        strategyId: i === 0 ? "c1" : "c2",
        executionKey: key,
        role: "open",
      },
      targets: [{ lifecycleId: "A:p-open", quantity: "-1" }],
    },
  }));
  expect(() =>
    projectLifecycles(f.ledger, f.projection, decisions, ids),
  ).toThrow(/reserved/);
});
it("compares explicit timezone offsets before reserving shares", () => {
  const f = assigned();
  const buy = f.ledger.executions.find((e) => e.key === "s-buy");
  if (buy) {
    buy.rawDateTime = "2026-10-02T13:00:00+02:00";
  }
  const c = fixture([
    ["calls", execution("offset-call", call, "-1", "100", 2, "open")],
  ]);
  f.ledger.executions.push(...c.ledger.executions);
  f.projection.allocations.push(...c.projection.allocations);
  f.projection.strategies.push(...c.projection.strategies);
  expect(
    projectLifecycles(f.ledger, f.projection, [], ids).suggestions,
  ).toHaveLength(1);
});
it("resolves a shared stock disposal through explicit quantity partitions", () => {
  const f = assigned();
  const secondPut = { ...put, key: "put2", conid: "22" };
  const extra = fixture([
    ["put-two", execution("p2-open", secondPut, "-1", "200", 1, "open")],
    [
      "put-two",
      execution("p2-assign", secondPut, "1", "0", 3, "close", "assignment"),
    ],
    [
      "stock-origin",
      execution("s-buy2", stock, "100", "-10000", 3, "open", "assignment"),
    ],
    [
      "stock-origin",
      execution("combined-sale", stock, "-200", "21000", 8, "close"),
    ],
  ]);
  f.ledger.executions.push(...extra.ledger.executions);
  f.projection.allocations.push(...extra.projection.allocations);
  f.projection.strategies.push(
    ...extra.projection.strategies.filter((s) => s.id !== "stock-origin"),
  );
  f.projection.links.push({
    from: "put-two",
    to: "stock-origin",
    type: "assignment",
    sources: [],
  });
  const d = {
    id: "__validate__",
    sequence: 1,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      assignments: [
        {
          lifecycleId: "A:p-open",
          allocation: {
            strategyId: "stock-origin",
            executionKey: "combined-sale",
            role: "close",
          },
          quantity: "-100",
        },
        {
          lifecycleId: "A:p2-open",
          allocation: {
            strategyId: "stock-origin",
            executionKey: "combined-sale",
            role: "close",
          },
          quantity: "-100",
        },
      ],
    },
  };
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, [d], ids),
  );
  expect(p.lifecycles).toHaveLength(2);
  expect(p.lifecycles.map((l) => l.status)).toEqual(["closed", "closed"]);
  expect(p.lifecycles.map((l) => l.reconstructedPnl)).toEqual(["700", "700"]);
  expect(validateMembership(f.ledger, f.projection, p.members)).toEqual([]);
});
it("suggests a multi-contract call that can be covered across two lifecycles", () => {
  const f = assigned();
  const extra = fixture([
    [
      "second-stock",
      execution("second-stock-open", stock, "100", "-10000", 1, "open"),
    ],
    ["calls", execution("two-contracts", call, "-2", "200", 3, "open")],
  ]);
  f.ledger.executions.push(...extra.ledger.executions);
  f.projection.allocations.push(...extra.projection.allocations);
  f.projection.strategies.push(...extra.projection.strategies);
  const p = projectLifecycles(f.ledger, f.projection, [], ids);
  expect(p.suggestions[0]?.candidateLifecycleIds).toEqual([
    "A:p-open",
    "A:second-stock-open",
  ]);
});
it("does not partially apply a retained correction that becomes invalid", () => {
  const f = assigned();
  const d = {
    id: "retained-bad",
    sequence: 1,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      assignments: [
        {
          lifecycleId: "A:s-buy",
          allocation: {
            strategyId: "put-origin",
            executionKey: "p-open",
            role: "open",
          },
          quantity: "-1",
        },
        {
          lifecycleId: "missing",
          allocation: {
            strategyId: "put-origin",
            executionKey: "p-assign",
            role: "close",
          },
          quantity: "1",
        },
      ],
    },
  };
  const p = projectLifecycles(f.ledger, f.projection, [d], ids);
  expect(
    p.members.find((m) => m.allocation.executionKey === "p-open")?.lifecycleId,
  ).toBe("A:p-open");
});
it("keeps lifecycle identities and results when presentation strategies are merged", () => {
  const f = fixture([
    ["first", execution("first-open", stock, "100", "-10000", 1, "open")],
    ["first", execution("first-close", stock, "-100", "10100", 2, "close")],
    ["second", execution("second-open", stock, "100", "-10000", 3, "open")],
    ["second", execution("second-close", stock, "-100", "10200", 4, "close")],
  ]);
  const merged = {
    ...f.projection,
    strategies: f.projection.strategies.slice(0, 1),
    allocations: f.projection.allocations.map((a) => ({
      ...a,
      strategyId: "first",
    })),
  };
  const p = accountLifecycles(
    f.ledger,
    merged,
    projectLifecycles(f.ledger, merged, [], ids, f.projection),
  );
  expect(p.lifecycles.map((l) => l.id)).toEqual([
    "A:first-open",
    "A:second-open",
  ]);
  expect(p.lifecycles.map((l) => l.reconstructedPnl)).toEqual(["100", "200"]);
  expect(validateMembership(f.ledger, merged, p.members)).toEqual([]);
  expect(p.members.every((m) => m.allocation.strategyId === "first")).toBe(
    true,
  );
});
it("uses a validated manual assignment link even when raw lifecycle codes are absent", () => {
  const f = assigned(true);
  for (const e of f.ledger.executions) e.event = "trade";
  const link = f.projection.links[0];
  if (!link) throw Error("missing assignment link");
  link.sources = f.ledger.executions
    .filter((e) => ["p-assign", "s-buy"].includes(e.key))
    .flatMap((e) => e.sources);
  expect(
    projectLifecycles(f.ledger, f.projection, [], ids).lifecycles,
  ).toHaveLength(1);
});
it("rejects moving a different known stock contract behind an identical display symbol", () => {
  const f = fixture([
    ["first-stock", execution("first", stock, "100", "-10000", 1, "open")],
    [
      "other-stock",
      execution(
        "other",
        { ...stock, key: "other-stock", conid: "999" },
        "100",
        "-10000",
        2,
        "open",
      ),
    ],
  ]);
  const d = {
    id: "__validate__",
    sequence: 1,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      assignments: [
        {
          lifecycleId: "A:first",
          allocation: {
            strategyId: "other-stock",
            executionKey: "other",
            role: "open",
          },
          quantity: "100",
        },
      ],
    },
  };
  expect(() => projectLifecycles(f.ledger, f.projection, [d], ids)).toThrow(
    /stock contract/,
  );
});
it("rejects an earlier call attachment that overlaps a later accepted call", () => {
  const f = assigned();
  const extra = fixture([
    ["early", execution("early", call, "-1", "100", 3, "open")],
    [
      "later",
      execution(
        "later",
        { ...call, key: "later-call" },
        "-1",
        "100",
        4,
        "open",
      ),
    ],
  ]);
  f.ledger.executions.push(...extra.ledger.executions);
  f.projection.allocations.push(...extra.projection.allocations);
  f.projection.strategies.push(...extra.projection.strategies);
  const ds = ["later", "early"].map((name, i) => ({
    id: "__validate__",
    sequence: i + 1,
    kind: "lifecycle_attachment",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      opening: { strategyId: name, executionKey: name, role: "open" },
      targets: [{ lifecycleId: "A:p-open", quantity: "-1" }],
    },
  }));
  expect(() => projectLifecycles(f.ledger, f.projection, ds, ids)).toThrow(
    /overlap/,
  );
});
it("does not close a lifecycle using stock sold before that lifecycle acquired shares", () => {
  const f = assigned();
  const extra = fixture([
    [
      "unrelated-stock",
      execution("old-open", stock, "100", "-10000", 1, "open"),
    ],
    [
      "unrelated-stock",
      execution("old-sale", stock, "-100", "10100", 1, "close"),
    ],
  ]);
  const oldOpening = extra.ledger.executions[0];
  if (!oldOpening) throw Error("missing opening");
  oldOpening.rawDateTime = "2026-10-01T10:00:00Z";
  f.ledger.executions.push(...extra.ledger.executions);
  f.projection.allocations.push(...extra.projection.allocations);
  f.projection.strategies.push(...extra.projection.strategies);
  const d = {
    id: "retained",
    sequence: 1,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      assignments: [
        {
          lifecycleId: "A:p-open",
          allocation: {
            strategyId: "unrelated-stock",
            executionKey: "old-sale",
            role: "close",
          },
          quantity: "-100",
        },
      ],
    },
  };
  const p = projectLifecycles(f.ledger, f.projection, [d], ids);
  expect(p.lifecycles.find((l) => l.id === "A:p-open")?.status).toBe(
    "unresolved",
  );
});
it("reserves calls with uncertain relative opening times instead of treating them as free capacity", () => {
  const f = assigned();
  const extra = fixture([
    ["first-call", execution("date-call1", call, "-1", "100", 3, "open")],
    [
      "second-call",
      execution(
        "date-call2",
        { ...call, key: "date-call2" },
        "-1",
        "100",
        3,
        "open",
      ),
    ],
  ]);
  for (const e of extra.ledger.executions) e.rawDateTime = e.date;
  f.ledger.executions.push(...extra.ledger.executions);
  f.projection.allocations.push(...extra.projection.allocations);
  f.projection.strategies.push(...extra.projection.strategies);
  const ds = ["date-call1", "date-call2"].map((key, i) => ({
    id: "__validate__",
    sequence: i + 1,
    kind: "lifecycle_attachment",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      opening: {
        strategyId: i === 0 ? "first-call" : "second-call",
        executionKey: key,
        role: "open",
      },
      targets: [{ lifecycleId: "A:p-open", quantity: "-1" }],
    },
  }));
  expect(() => projectLifecycles(f.ledger, f.projection, ds, ids)).toThrow(
    /reserved|overlap/,
  );
});
it("rejects covered-call attachment when conflicting stock contracts make its underlying ambiguous", () => {
  const f = fixture([
    ["stock-one", execution("stock-one", stock, "100", "-10000", 1, "open")],
    [
      "stock-two",
      execution(
        "stock-two",
        { ...stock, key: "stock-two", conid: "999" },
        "100",
        "-10000",
        1,
        "open",
      ),
    ],
    ["calls", execution("new-call", call, "-1", "100", 3, "open")],
  ]);
  const d = {
    id: "__validate__",
    sequence: 1,
    kind: "lifecycle_attachment",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      opening: { strategyId: "calls", executionKey: "new-call", role: "open" },
      targets: [{ lifecycleId: "A:stock-one", quantity: "-1" }],
    },
  };
  expect(() => projectLifecycles(f.ledger, f.projection, [d], ids)).toThrow(
    /ambiguous/,
  );
});
it("shows the assigned-stock stage for manually corrected trade-coded assignment events", () => {
  const f = assigned();
  for (const e of f.ledger.executions) e.event = "trade";
  const link = f.projection.links[0];
  if (!link) throw Error("missing link");
  link.sources = f.ledger.executions
    .filter((e) => ["p-assign", "s-buy"].includes(e.key))
    .flatMap((e) => e.sources);
  expect(
    projectLifecycles(f.ledger, f.projection, [], ids).lifecycles[0]?.stage,
  ).toBe("assigned_stock");
});
it("keeps a confirmed call with the chosen lot when another eligible lot remains", () => {
  const f = assigned();
  const extra = fixture([
    [
      "other-stock",
      execution("other-stock-open", stock, "100", "-10000", 1, "open"),
    ],
    ["calls", execution("chosen-call", call, "-1", "100", 3, "open")],
  ]);
  f.ledger.executions.push(...extra.ledger.executions);
  f.projection.allocations.push(...extra.projection.allocations);
  f.projection.strategies.push(...extra.projection.strategies);
  const decisions = [
    {
      id: "confirmed",
      sequence: 1,
      kind: "lifecycle_attachment",
      sources: [],
      strategyIds: [],
      supersedesId: null,
      payload: {
        opening: {
          strategyId: "calls",
          executionKey: "chosen-call",
          role: "open",
        },
        targets: [{ lifecycleId: "A:p-open", quantity: "-1" }],
      },
    },
  ];
  for (let i = 0; i < 2; i++) {
    const p = projectLifecycles(f.ledger, f.projection, decisions, ids);
    expect(p.suggestions).toEqual([]);
    expect(p.lifecycles.map((l) => l.status)).toEqual(["open", "open"]);
    expect(
      p.members.find((m) => m.allocation.executionKey === "chosen-call")
        ?.lifecycleId,
    ).toBe("A:p-open");
  }
  const closes = fixture([
    [
      "stock-origin",
      execution("chosen-sale", stock, "-100", "10500", 8, "close"),
    ],
    ["calls", execution("chosen-close", call, "1", "0", 8, "close")],
  ]);
  f.ledger.executions.push(...closes.ledger.executions);
  f.projection.allocations.push(...closes.projection.allocations);
  const completed = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, decisions, ids),
  );
  expect(completed.suggestions).toEqual([]);
  expect(completed.lifecycles.find((l) => l.id === "A:p-open")).toMatchObject({
    status: "closed",
    reconstructedPnl: "800",
  });
  expect(
    completed.lifecycles.find((l) => l.id === "A:other-stock-open")?.status,
  ).toBe("open");
});
it("selects the first intraday fill rather than the first lexical execution key", () => {
  const first = execution("z-first-fill", stock, "50", "-5000", 1, "open");
  first.rawDateTime = "2026-10-01T10:00:00Z";
  const later = execution("a-later-fill", stock, "50", "-5000", 1, "open");
  later.rawDateTime = "2026-10-01T11:00:00Z";
  const f = fixture([
    ["same-order", first],
    ["same-order", later],
  ]);
  expect(
    projectLifecycles(f.ledger, f.projection, [], ids).lifecycles[0]?.id,
  ).toBe("A:z-first-fill");
});
it("shows confirmed calls against purchased shares as a covered-call stage", () => {
  const f = fixture([
    ["holding", execution("holding-open", stock, "100", "-10000", 1, "open")],
    ["calls", execution("purchased-call", call, "-1", "100", 3, "open")],
  ]);
  const d = {
    id: "confirmed",
    sequence: 1,
    kind: "lifecycle_attachment",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      opening: {
        strategyId: "calls",
        executionKey: "purchased-call",
        role: "open",
      },
      targets: [{ lifecycleId: "A:holding-open", quantity: "-1" }],
    },
  };
  const p = projectLifecycles(f.ledger, f.projection, [d], ids);
  expect(p.lifecycles[0]).toMatchObject({
    stage: "covered_call",
    coveredShares: "100",
  });
});

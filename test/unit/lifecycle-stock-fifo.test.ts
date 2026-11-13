import { expect, it } from "vitest";
import { accountLifecycles } from "../../src/server/lifecycles/accounting.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import type { Decision } from "../../src/shared/domain.js";
import {
  assigned,
  call,
  execution,
  fixture,
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

/**
 * HIMS 2025: two put assignments deliver two 100-share lots (Feb, then Apr)
 * into one stock position. IBKR closes the earliest lot first.
 */
function twoAssignedLots(saleQuantity: string, saleCash: string) {
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
      execution("sale", stock, saleQuantity, saleCash, 8, "close"),
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
  const p = projectLifecycles(f.ledger, f.projection, [], ids);
  const sold = (lifecycleId: string) =>
    p.members
      .filter(
        (m) =>
          m.allocation.executionKey === "sale" && m.lifecycleId === lifecycleId,
      )
      .map((m) => m.quantity);
  return { p, sold };
}

it("closes the earliest assigned share lot first", () => {
  const { p, sold } = twoAssignedLots("-100", "10500");
  expect(p.issues).not.toContainEqual(
    expect.objectContaining({ code: "LIFECYCLE_STOCK_CLOSE_AMBIGUOUS" }),
  );
  expect(sold("A:p-open")).toEqual(["-100"]);
  expect(sold("A:p2-open")).toEqual([]);
});

it("spills a sale larger than the earliest lot into the next lot", () => {
  const { p, sold } = twoAssignedLots("-200", "21000");
  expect(p.issues).not.toContainEqual(
    expect.objectContaining({ code: "LIFECYCLE_STOCK_CLOSE_AMBIGUOUS" }),
  );
  expect(sold("A:p-open")).toEqual(["-100"]);
  expect(sold("A:p2-open")).toEqual(["-100"]);
});

/**
 * HIMS 2025: the user connected C1 to the later lot and C2 to the earlier
 * lot. C1 is bought back in the same instant 100 shares are sold; C2 is later
 * assigned. IBKR's FIFO would sell the earlier lot first, but the user's
 * pairing decides lifecycle ownership; the IBKR tax-lot split is only noted.
 */
it("lets the user's covered-call connections decide which lot shares leave", () => {
  const f = assigned();
  const secondPut = { ...put, key: "put2", conid: "22" };
  const c1 = { ...call, key: "c1", conid: "31" };
  const c2 = { ...call, key: "c2", conid: "32" };
  const extra = fixture([
    ["put-two", execution("p2-open", secondPut, "-1", "200", 1, "open")],
    [
      "put-two",
      execution("p2-assign", secondPut, "1", "0", 3, "close", "assignment"),
    ],
    [
      "stock-origin",
      execution("s-buy2", stock, "100", "-9000", 3, "open", "assignment"),
    ],
    ["c1", execution("c1-open", c1, "-1", "100", 4, "open")],
    ["c1", execution("c1-close", c1, "1", "-50", 8, "close")],
    ["stock-origin", execution("sale", stock, "-100", "10500", 8, "close")],
    ["c2", execution("c2-open", c2, "-1", "120", 5, "open")],
    ["c2", execution("c2-assign", c2, "1", "0", 9, "close", "assignment")],
    [
      "stock-origin",
      execution("call-away", stock, "-100", "11000", 9, "close", "assignment"),
    ],
  ]);
  f.ledger.executions.push(...extra.ledger.executions);
  f.projection.allocations.push(...extra.projection.allocations);
  f.projection.strategies.push(
    ...extra.projection.strategies.filter((s) => s.id !== "stock-origin"),
  );
  f.projection.links.push(
    { from: "put-two", to: "stock-origin", type: "assignment", sources: [] },
    {
      from: "c2",
      to: "stock-origin",
      type: "assignment",
      sources: [{ importId: "imp", rowNumber: 9 }],
    },
  );
  const connect = (
    id: string,
    sequence: number,
    strategyId: string,
    lifecycleId: string,
  ): Decision => ({
    id,
    sequence,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      requireCallCoverage: true,
      assignments: f.projection.allocations
        .filter((a) => a.strategyId === strategyId)
        .map((a) => ({
          allocation: {
            strategyId: a.strategyId,
            executionKey: a.executionKey,
            role: a.role,
          },
          lifecycleId,
          quantity: a.quantity,
        })),
    },
  });
  const decisions = [
    connect("d1", 1, "c1", "A:p2-open"),
    connect("d2", 2, "c2", "A:p-open"),
  ];
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, decisions, ids),
  );
  const ownerOf = (key: string) =>
    p.members
      .filter((m) => m.allocation.executionKey === key)
      .map((m) => m.lifecycleId);
  expect(ownerOf("sale")).toEqual(["A:p2-open"]);
  expect(ownerOf("call-away")).toEqual(["A:p-open"]);
  expect(ownerOf("c2-assign")).toEqual(["A:p-open"]);
  const codes = p.issues.map((i) => i.code);
  expect(codes).not.toContain("LIFECYCLE_DECISION_UNRESOLVED");
  expect(codes).not.toContain("PNL_RECONCILIATION");
  for (const id of ["A:p-open", "A:p2-open"])
    expect(p.lifecycles.find((l) => l.id === id)?.reasons).toContain(
      "IBKR_TAX_LOT_DIFFERS",
    );
});

/**
 * The real HIMS shape: each put assignment delivers shares into its own stock
 * strategy, and strategy-level FIFO has already placed the 05-16 sale in the
 * earlier lot and the June call-away in the later lot. The user's pairing
 * still decides lifecycle ownership.
 */
it("applies the user's pairing when each assignment has its own share strategy", () => {
  const putA = { ...put, key: "put-a", conid: "41" };
  const putB = { ...put, key: "put-b", conid: "42" };
  const c1 = { ...call, key: "c1", conid: "51" };
  const c2 = { ...call, key: "c2", conid: "52" };
  const f = fixture(
    [
      ["put-a", execution("pa-open", putA, "-1", "300", 1, "open")],
      [
        "put-a",
        execution("pa-assign", putA, "1", "0", 2, "close", "assignment"),
      ],
      [
        "stock-a",
        execution("sa-buy", stock, "100", "-5300", 2, "open", "assignment"),
      ],
      ["put-b", execution("pb-open", putB, "-1", "100", 2, "open")],
      [
        "put-b",
        execution("pb-assign", putB, "1", "0", 3, "close", "assignment"),
      ],
      [
        "stock-b",
        execution("sb-buy", stock, "100", "-3050", 3, "open", "assignment"),
      ],
      ["c1", execution("c1-open", c1, "-1", "177", 4, "open")],
      ["c1", execution("c1-close", c1, "1", "-3134", 8, "close")],
      // FIFO put the 05-16-style sale in the earlier lot's strategy.
      ["stock-a", execution("sale", stock, "-100", "6181", 8, "close")],
      ["c2", execution("c2-open", c2, "-1", "277", 5, "open")],
      ["c2", execution("c2-assign", c2, "1", "0", 9, "close", "assignment")],
      // ...and the call-away in the later lot's strategy.
      [
        "stock-b",
        execution("call-away", stock, "-100", "6000", 9, "close", "assignment"),
      ],
    ],
    [
      { from: "put-a", to: "stock-a", type: "assignment", sources: [] },
      { from: "put-b", to: "stock-b", type: "assignment", sources: [] },
      {
        from: "c2",
        to: "stock-b",
        type: "assignment",
        sources: [{ importId: "imp", rowNumber: 9 }],
      },
    ],
  );
  const lotA = "A:pa-open";
  const lotB = "A:pb-open";
  const connect = (
    id: string,
    sequence: number,
    strategyId: string,
    lifecycleId: string,
  ): Decision => ({
    id,
    sequence,
    kind: "lifecycle_membership",
    sources: [],
    strategyIds: [],
    supersedesId: null,
    payload: {
      requireCallCoverage: true,
      assignments: f.projection.allocations
        .filter((a) => a.strategyId === strategyId)
        .map((a) => ({
          allocation: {
            strategyId: a.strategyId,
            executionKey: a.executionKey,
            role: a.role,
          },
          lifecycleId,
          quantity: a.quantity,
        })),
    },
  });
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(
      f.ledger,
      f.projection,
      [connect("d1", 1, "c1", lotB), connect("d2", 2, "c2", lotA)],
      ids,
    ),
  );
  const ownerOf = (key: string) =>
    p.members
      .filter((m) => m.allocation.executionKey === key)
      .map((m) => m.lifecycleId);
  expect(ownerOf("sale")).toEqual([lotB]);
  expect(ownerOf("call-away")).toEqual([lotA]);
  expect(ownerOf("c2-assign")).toEqual([lotA]);
  const codes = p.issues.map((i) => i.code);
  expect(codes).not.toContain("LIFECYCLE_DECISION_UNRESOLVED");
  expect(codes).not.toContain("LIFECYCLE_EXPOSURE_UNRESOLVED");
  expect(codes).not.toContain("PNL_RECONCILIATION");
  for (const id of [lotA, lotB]) {
    const lifecycle = p.lifecycles.find((l) => l.id === id);
    expect(lifecycle?.status).toBe("closed");
    expect(lifecycle?.reasons).toContain("IBKR_TAX_LOT_DIFFERS");
  }
});

it("splits IBKR's P&L across FIFO lots by each lot's own cost", () => {
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
      execution("s-buy2", stock, "100", "-9000", 3, "open", "assignment"),
    ],
    [
      "stock-origin",
      {
        ...execution("sale", stock, "-200", "21000", 8, "close"),
        brokerPnl: "2000",
      },
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
  const p = projectLifecycles(f.ledger, f.projection, [], ids);
  const pnl = (lifecycleId: string) =>
    p.members.find(
      (m) =>
        m.allocation.executionKey === "sale" && m.lifecycleId === lifecycleId,
    )?.brokerPnl;
  // Earlier lot cost 10000, later lot 9000; each sold half for 10500.
  expect(pnl("A:p-open")).toBe("500");
  expect(pnl("A:p2-open")).toBe("1500");
});

import { expect, it } from "vitest";
import {
  accountLifecycles,
  brokerRealized,
} from "../../src/server/lifecycles/accounting.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { valueLifecycles } from "../../src/server/lifecycles/valuation.js";
import {
  assigned,
  call,
  execution,
  fixture,
  put,
  stock,
} from "../fixtures/lifecycles.js";

it("keeps broker realized unavailable for openings without any reported P&L evidence", () => {
  const f = fixture([
    ["stock", execution("stock-open", stock, "100", "-10000", 1, "open")],
  ]);
  const p = projectLifecycles(f.ledger, f.projection, []);
  expect(brokerRealized(f.ledger, p.members)).toMatchObject({
    value: null,
    reasons: ["BROKER_PNL_INCOMPLETE"],
  });
  const opening = p.members[0];
  if (!opening) throw Error("Missing fixture member");
  opening.brokerPnl = "0";
  expect(brokerRealized(f.ledger, p.members)).toMatchObject({
    value: "0",
    reasons: [],
  });
});

it.each(["missing_cash", "conflicts"])(
  "withholds unreliable lifecycle cash results and marks for %s",
  (failure) => {
    for (const closed of [false, true]) {
      const f = assigned(closed);
      if (failure === "missing_cash")
        f.ledger.issues.push({
          key: "missing-cash",
          code: "missing_net_cash",
          severity: "error",
          sources: [],
        });
      else f.ledger.conflicts = 1;
      const p = accountLifecycles(
        f.ledger,
        f.projection,
        projectLifecycles(f.ledger, f.projection, []),
      );
      expect(p.lifecycles[0]).toMatchObject({
        complete: false,
        reconstructedPnl: null,
      });
      expect(p.lifecycles[0]?.reasons).toContain("QUARANTINED_EVIDENCE");
      if (closed) expect(p.lifecycles[0]?.brokerPnl).toBe("0");
      else
        expect(
          valueLifecycles(f.ledger, p, [
            {
              account: "A",
              currency: "USD",
              asOf: "2026-10-03T12:00:00Z",
              marks: [{ instrumentKey: "stock", price: "95" }],
            },
          ])[0],
        ).toMatchObject({ totalPnl: null, realizedBrokerPnl: "0" });
    }
  },
);

it("preserves missing broker coverage on assignment and nets cash only once", () => {
  const f = assigned(true);
  const e = f.ledger.executions.find((e) => e.key === "p-assign");
  if (e) e.brokerPnl = null;
  const a = f.projection.allocations.find((a) => a.executionKey === "p-assign");
  if (a) a.brokerPnl = null;
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, []),
  );
  expect(p.lifecycles[0]?.reconstructedPnl).toBe("-150");
  expect(p.lifecycles[0]?.brokerPnl).toBeNull();
});
it("replays call opening attachment onto its later close", () => {
  const f = assigned();
  const calls = fixture([
    ["calls", execution("c-open", call, "-1", "100", 3, "open")],
    ["calls", execution("c-close", call, "1", "-20", 5, "close")],
  ]);
  f.ledger.executions.push(...calls.ledger.executions);
  f.projection.allocations.push(...calls.projection.allocations);
  f.projection.strategies.push(...calls.projection.strategies);
  const draft = projectLifecycles(f.ledger, f.projection, []);
  const id = draft.lifecycles.find(
    (l) => l.originStrategyType === "short_put",
  )?.id;
  const decisions = [
    {
      id: "d",
      sequence: 1,
      kind: "lifecycle_attachment",
      sources: [],
      strategyIds: [],
      supersedesId: null,
      payload: {
        opening: { strategyId: "calls", executionKey: "c-open", role: "open" },
        targets: [{ lifecycleId: id, quantity: "-1" }],
      },
    },
  ];
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, decisions),
  );
  expect(p.suggestions).toHaveLength(0);
  expect(p.lifecycles).toHaveLength(1);
  expect(p.lifecycles[0]?.cashflow).toBe("-9720");
  expect(p.lifecycles[0]?.status).toBe("open");
});
it("adds put, stock, call and call-away cash to one completed wheel cycle", () => {
  const f = fixture(
    [
      ["put-origin", execution("po", put, "-1", "200", 1, "open")],
      ["put-origin", execution("pa", put, "1", "0", 2, "close", "assignment")],
      [
        "stock",
        execution("so", stock, "100", "-10000", 2, "open", "assignment"),
      ],
      [
        "stock",
        execution("sc", stock, "-100", "10500", 8, "close", "assignment"),
      ],
      ["calls", execution("co", call, "-1", "100", 3, "open")],
      ["calls", execution("cc", call, "1", "0", 8, "close", "assignment")],
    ],
    [
      { from: "put-origin", to: "stock", type: "assignment", sources: [] },
      { from: "calls", to: "stock", type: "assignment", sources: [] },
    ],
  );
  const draft = projectLifecycles(f.ledger, f.projection, []);
  const id = draft.lifecycles.find(
    (l) => l.originStrategyType === "short_put",
  )?.id;
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, [
      {
        id: "d",
        sequence: 1,
        kind: "lifecycle_attachment",
        sources: [],
        strategyIds: [],
        supersedesId: null,
        payload: {
          opening: { strategyId: "calls", executionKey: "co", role: "open" },
          targets: [{ lifecycleId: id, quantity: "-1" }],
        },
      },
    ]),
  );
  expect(p.lifecycles).toHaveLength(1);
  expect(p.lifecycles[0]).toMatchObject({
    status: "closed",
    reconstructedPnl: "800",
  });
});

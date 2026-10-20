import { describe, expect, it } from "vitest";
import { campaignSummary } from "../../src/server/analytics/lifecycles.js";
import {
  accountLifecycles,
  lifecycleOutcome,
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw Error("Missing test fixture value");
  return value;
}

function eventFixture(event: "assignment" | "exercise", short: boolean) {
  const opening = execution(
    "option-open",
    call,
    short ? "-1" : "1",
    short ? "100" : "-30",
    1,
    "open",
  );
  const closing = {
    ...execution(
      "option-event",
      call,
      short ? "1" : "-1",
      "0",
      2,
      "close",
      event,
    ),
    brokerPnl: short ? "-2400" : "470",
  };
  return fixture([
    ["option", opening],
    ["option", closing],
  ]);
}
function account(f: ReturnType<typeof fixture>) {
  return accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, []),
  );
}

describe("lifecycle assignment/exercise cash evidence", () => {
  it.each(["assignment", "exercise"] as const)(
    "withholds reconstruction for an unmatched %s while retaining broker coverage",
    (event) => {
      const p = account(eventFixture(event, event === "assignment"));
      const l = required(p.lifecycles[0]);
      expect(l).toMatchObject({
        status: "closed",
        complete: true,
        reconstructedPnl: null,
        brokerPnl: event === "assignment" ? "-2400" : "470",
        cashflow: event === "assignment" ? "100" : "-30",
      });
      expect(l.reasons).toContain("EVENT_CASH_UNRESOLVED");
      expect(p.issues.map((i) => i.code)).toEqual(["EVENT_CASH_UNRESOLVED"]);
      expect(lifecycleOutcome(l, "broker")).toBe(
        event === "assignment" ? "loss" : "win",
      );
      expect(lifecycleOutcome(l, "reconstructed")).toBe("unavailable");
      l.campaignId = "campaign";
      expect(campaignSummary(p, "campaign")).toMatchObject({
        broker: { eligible: 1 },
        reconstructed: { eligible: 0, missing: 1 },
      });
    },
  );

  it("does not certify an unmatched event from nonzero cash or matching broker P&L", () => {
    const f = eventFixture("exercise", false);
    const close = required(f.ledger.executions[1]);
    close.netCash = "500";
    close.brokerPnl = "470";
    required(f.projection.allocations[1]).netCash = "500";
    required(f.projection.allocations[1]).brokerPnl = "470";
    const p = account(f);
    expect(required(p.lifecycles[0]).reconstructedPnl).toBeNull();
    expect(p.issues.map((i) => i.code)).toEqual(["EVENT_CASH_UNRESOLVED"]);
  });

  it("does not borrow stock delivery quantities from another lifecycle", () => {
    const f = assigned(true);
    const p = projectLifecycles(f.ledger, f.projection, []);
    const delivery = p.members.find(
      (m) => m.allocation.executionKey === "s-buy",
    );
    if (!delivery) throw Error("Missing stock delivery");
    delivery.quantity = "50";
    delivery.netCash = "-5000";
    accountLifecycles(f.ledger, f.projection, p);
    expect(required(p.lifecycles[0]).reconstructedPnl).toBeNull();
    expect(required(p.lifecycles[0]).reasons).toContain(
      "EVENT_CASH_UNRESOLVED",
    );
  });

  it("requires event-specific delivery provenance rather than another event's link", () => {
    const f = assigned(true);
    const event = f.ledger.executions.find((e) => e.key === "p-assign");
    const delivery = f.ledger.executions.find((e) => e.key === "s-buy");
    if (!event || !delivery) throw Error("Missing event pair");
    event.sources = [{ importId: "events", rowNumber: 10 }];
    delivery.sources = [{ importId: "events", rowNumber: 20 }];
    required(f.projection.links[0]).sources = [
      { importId: "events", rowNumber: 30 },
      required(delivery.sources[0]),
    ];
    const p = account(f);
    expect(p.lifecycles.flatMap((l) => l.reasons)).toContain(
      "EVENT_CASH_UNRESOLVED",
    );
  });

  it("does not double count one delivery against two option events", () => {
    const f = assigned(true);
    const second = execution(
      "second-event",
      put,
      "1",
      "0",
      2,
      "close",
      "assignment",
    );
    f.ledger.executions.push(second);
    f.projection.allocations.push({
      ...required(f.projection.allocations[1]),
      executionKey: second.key,
    });
    const p = account(f);
    expect(p.lifecycles.flatMap((l) => l.reasons)).toContain(
      "EVENT_CASH_UNRESOLVED",
    );
  });

  it("combines slices of the same option event before checking owned delivery", () => {
    const f = assigned(true);
    const p = projectLifecycles(f.ledger, f.projection, []);
    const event = p.members.find(
      (m) => m.allocation.executionKey === "p-assign",
    );
    if (!event) throw Error("Missing option event");
    event.quantity = "0.5";
    p.members.push({
      ...event,
      allocation: { ...event.allocation, strategyId: "another-slice" },
    });
    accountLifecycles(f.ledger, f.projection, p);
    expect(required(p.lifecycles[0]).reconstructedPnl).toBe("-150");
    expect(required(p.lifecycles[0]).reasons).not.toContain(
      "EVENT_CASH_UNRESOLVED",
    );
  });

  it("preserves event evidence when presentation grouping removes self-links", () => {
    const f = assigned(true);
    const event = required(
      f.ledger.executions.find((e) => e.key === "p-assign"),
    );
    const delivery = required(
      f.ledger.executions.find((e) => e.key === "s-buy"),
    );
    required(f.projection.links[0]).sources = [
      ...event.sources,
      ...delivery.sources,
    ];
    const presentation = {
      ...f.projection,
      strategies: [
        { ...required(f.projection.strategies[0]), id: "presentation" },
      ],
      allocations: f.projection.allocations.map((a) => ({
        ...a,
        strategyId: "presentation",
      })),
      links: [],
    };
    const p = projectLifecycles(
      f.ledger,
      presentation,
      [],
      undefined,
      f.projection,
    );
    accountLifecycles(f.ledger, f.projection, p);
    expect(required(p.lifecycles[0]).reconstructedPnl).toBe("-150");
    expect(p.issues.map((i) => i.code)).not.toContain("EVENT_CASH_UNRESOLVED");
  });

  it("retains reconstruction for a complete physical assignment lifecycle", () => {
    const p = account(assigned(true));
    expect(required(p.lifecycles[0])).toMatchObject({
      status: "closed",
      reconstructedPnl: "-150",
    });
    expect(required(p.lifecycles[0]).reasons).not.toContain(
      "EVENT_CASH_UNRESOLVED",
    );
  });

  it.each(["trade", "expiry"] as const)(
    "preserves ordinary %s reconstruction and real discrepancies",
    (event) => {
      const f = fixture([
        ["option", execution("open", call, "1", "-30", 1, "open")],
        [
          "option",
          {
            ...execution("close", call, "-1", "0", 2, "close", event),
            brokerPnl: "-20",
          },
        ],
      ]);
      const p = account(f);
      expect(required(p.lifecycles[0]).reconstructedPnl).toBe("-30");
      expect(p.issues.map((i) => i.code)).toEqual(["PNL_RECONCILIATION"]);
    },
  );

  it("does not present missing event cash as closed unrealized P&L", () => {
    const f = eventFixture("assignment", true);
    const p = account(f);
    expect(valueLifecycles(f.ledger, p, [])[0]).toMatchObject({
      totalPnl: null,
      unrealizedPnl: null,
      realizedBrokerPnl: "-2400",
      estimated: true,
      reasons: ["EVENT_CASH_UNRESOLVED"],
    });
  });

  it("withholds marked open totals when earlier event cash is unresolved", () => {
    const f = eventFixture("assignment", true);
    const extra = execution("stock-open", stock, "100", "-10000", 3, "open");
    f.ledger.executions.push(extra);
    f.projection.allocations.push({
      strategyId: "option",
      executionKey: extra.key,
      quantity: extra.quantity,
      netCash: extra.netCash,
      role: "open",
      brokerPnl: "0",
      pnlEstimated: false,
    });
    const p = account(f);
    expect(required(p.lifecycles[0]).status).toBe("open");
    expect(
      valueLifecycles(f.ledger, p, [
        {
          account: "A",
          currency: "USD",
          asOf: "2026-10-04T12:00:00Z",
          marks: [{ instrumentKey: "stock", price: "110" }],
        },
      ])[0],
    ).toMatchObject({
      totalPnl: null,
      unrealizedPnl: null,
      reasons: ["EVENT_CASH_UNRESOLVED"],
    });
  });
});

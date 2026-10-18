import { expect, it } from "vitest";
import { accountLifecycles } from "../../src/server/lifecycles/accounting.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { valueLifecycles } from "../../src/server/lifecycles/valuation.js";
import { assigned, execution, fixture, stock } from "../fixtures/lifecycles.js";

it("keeps an older applicable snapshot when newer marks concern an unrelated holding", () => {
  const f = assigned();
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, []),
  );
  const target = {
    account: "A",
    currency: "USD",
    asOf: "2026-10-03T12:00:00Z",
    marks: [{ instrumentKey: "stock", price: "95" }],
  };
  const unrelated = {
    ...target,
    asOf: "2026-10-04T12:00:00Z",
    marks: [{ instrumentKey: "other", price: "999" }],
  };
  expect(valueLifecycles(f.ledger, p, [target, unrelated])[0]).toMatchObject({
    asOf: target.asOf,
    totalPnl: "-300",
  });
});

it("does not combine incomplete applicable snapshots across timestamps", () => {
  const f = assigned();
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, []),
  );
  const cycle = p.lifecycles[0];
  if (!cycle) throw Error("Missing fixture lifecycle");
  cycle.positions.push({ instrumentKey: "put", quantity: "1" });
  const complete = {
    account: "A",
    currency: "USD",
    asOf: "2026-10-03T12:00:00Z",
    marks: [
      { instrumentKey: "stock", price: "95" },
      { instrumentKey: "put", price: "1" },
    ],
  };
  const partial = {
    ...complete,
    asOf: "2026-10-04T12:00:00Z",
    marks: [{ instrumentKey: "stock", price: "96" }],
  };
  expect(valueLifecycles(f.ledger, p, [complete, partial])[0]).toMatchObject({
    asOf: partial.asOf,
    totalPnl: null,
    reasons: ["VALUATION_MARKS_INCOMPLETE"],
  });
});

it.each([
  {
    raw: "2026-10-02T12:00:00",
    zone: "UTC",
    asOf: "2026-10-02T12:01:00Z",
    available: true,
  },
  {
    raw: "2026-10-02T12:00:00+0800",
    zone: null,
    asOf: "2026-10-02T04:01:00Z",
    available: true,
  },
  {
    raw: "2026-10-02T23:30:00",
    zone: "America/Los_Angeles",
    asOf: "2026-10-03T01:00:00Z",
    available: false,
  },
  {
    raw: "2026-10-02T23:30:00",
    zone: null,
    asOf: "2026-10-03T01:00:00Z",
    available: false,
  },
  {
    raw: "2026-10-02T23:30:00",
    zone: null,
    asOf: "2026-10-03T14:00:00Z",
    available: true,
  },
])(
  "compares valuation time without inventing a host timezone: %o",
  ({ raw, zone, asOf, available }) => {
    const row = execution("stock-open", stock, "100", "-10000", 2, "open");
    row.rawDateTime = raw;
    row.timezone = zone;
    const f = fixture([["stock", row]]);
    const p = accountLifecycles(
      f.ledger,
      f.projection,
      projectLifecycles(f.ledger, f.projection, []),
    );
    const result = valueLifecycles(f.ledger, p, [
      {
        account: "A",
        currency: "USD",
        asOf,
        marks: [{ instrumentKey: "stock", price: "95" }],
      },
    ])[0];
    expect(result?.totalPnl).toBe(available ? "-500" : null);
  },
);

it("marks assigned stock from cash plus market value, never its historical fill", () => {
  const f = assigned();
  const p = accountLifecycles(
    f.ledger,
    f.projection,
    projectLifecycles(f.ledger, f.projection, []),
  );
  const marks = [
    {
      account: "A",
      currency: "USD",
      asOf: "2026-10-03T12:00:00Z",
      marks: [{ instrumentKey: "stock", price: "95" }],
    },
  ];
  expect(valueLifecycles(f.ledger, p, marks)[0]).toMatchObject({
    totalPnl: "-300",
    realizedBrokerPnl: "0",
    unrealizedPnl: "-300",
    source: "manual",
  });
  expect(valueLifecycles(f.ledger, p, [])[0]?.totalPnl).toBeNull();
});
it("rejects an old or incomplete valuation instead of substituting zero", () => {
  const f = assigned();
  const p = projectLifecycles(f.ledger, f.projection, []);
  expect(
    valueLifecycles(f.ledger, p, [
      {
        account: "A",
        currency: "USD",
        asOf: "2026-10-01T12:00:00Z",
        marks: [{ instrumentKey: "stock", price: "95" }],
      },
    ])[0]?.totalPnl,
  ).toBeNull();
  expect(
    valueLifecycles(f.ledger, p, [
      {
        account: "A",
        currency: "USD",
        asOf: "2026-10-03T12:00:00Z",
        marks: [{ instrumentKey: "other", price: "0" }],
      },
    ])[0]?.totalPnl,
  ).toBeNull();
});

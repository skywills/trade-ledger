import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { lifecycleEventRows } from "../../src/web/lifecycles/connections.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

const at = (
  e: ReturnType<typeof execution>,
  rawDateTime: string,
): ReturnType<typeof execution> => ({ ...e, rawDateTime });

it("orders same-day lifecycle events by time, not input order", () => {
  // Mirrors AFRM 2024-10-11: the call buy-back (11:14:16) precedes the share
  // sale (11:14:35), but the members arrive with the share sale first.
  const executions = [
    at(
      execution("assigned", stock, "100", "-4300", 3, "open", "assignment"),
      "2026-10-03T16:20:00Z",
    ),
    at(
      execution("sell-shares", stock, "-100", "4500", 11, "close"),
      "2026-10-11T11:14:35Z",
    ),
    at(
      execution("call-open", call, "-1", "90", 4, "open"),
      "2026-10-04T09:40:34Z",
    ),
    at(
      execution("call-close", call, "1", "-335", 11, "close"),
      "2026-10-11T11:14:16Z",
    ),
  ].map((e) => ({ ...e, date: e.rawDateTime.slice(0, 10) }));
  const [assignedShares, sale, callOpen, callClose] = executions;
  if (!assignedShares || !sale || !callOpen || !callClose)
    throw Error("missing fixture executions");
  const f = fixture([
    ["shares", assignedShares],
    ["shares", sale],
    ["calls", callOpen],
    ["calls", callClose],
  ]);
  const members = projectLifecycles(f.ledger, f.projection, []).members;
  const keys = (rows: typeof members) =>
    rows.map((m) => m.allocation.executionKey);
  // Same-day share sale listed ahead of the earlier call buy-back.
  const scrambled = [
    ...members.filter((m) => m.allocation.executionKey === "sell-shares"),
    ...members.filter((m) => m.allocation.executionKey !== "sell-shares"),
  ];
  expect(keys(lifecycleEventRows(scrambled, executions))).toEqual([
    "assigned",
    "call-open",
    "call-close",
    "sell-shares",
  ]);
});

it("keeps date order when same-day times cannot be compared", () => {
  const executions = [
    {
      ...execution("day-two", stock, "-100", "4500", 2, "close"),
      rawDateTime: "2026-10-02",
      timezone: null,
    },
    {
      ...execution("day-one", stock, "100", "-4300", 1, "open"),
      rawDateTime: "2026-10-01",
      timezone: null,
    },
  ];
  const [dayTwo, dayOne] = executions;
  if (!dayTwo || !dayOne) throw Error("missing fixture executions");
  const f = fixture([
    ["shares", dayOne],
    ["shares", dayTwo],
  ]);
  const members = projectLifecycles(f.ledger, f.projection, []).members;
  const reversed = [...members].reverse();
  expect(
    lifecycleEventRows(reversed, executions).map(
      (m) => m.allocation.executionKey,
    ),
  ).toEqual(["day-one", "day-two"]);
});

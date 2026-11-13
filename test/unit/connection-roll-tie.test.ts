import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import type { Decision } from "../../src/shared/domain.js";
import { call, execution, fixture, stock } from "../fixtures/lifecycles.js";

const rolled = { ...call, key: "rolled-call", conid: "4" };

/**
 * A combo roll (HIMS 2025-03-07 10:44:19): the old covered call is bought back
 * and the new call sold in one order, so both fills carry the same timestamp.
 */
function rollAt(
  newCallTime: string,
  oldClose: {
    day: number;
    time: string;
    event?: "trade" | "expiry";
  } = { day: 3, time: "2026-10-03T10:44:19Z" },
  extra: Parameters<typeof fixture>[0] = [],
) {
  const { ledger, projection } = fixture([
    ...extra,
    ["shares", execution("shares", stock, "100", "-10000", 1, "open")],
    ["old", execution("old-open", call, "-1", "70", 2, "open")],
    [
      "old",
      {
        ...execution(
          "old-close",
          call,
          "1",
          oldClose.event === "expiry" ? "0" : "-30",
          oldClose.day,
          "close",
          oldClose.event ?? "trade",
        ),
        rawDateTime: oldClose.time,
      },
    ],
    [
      "new",
      {
        ...execution("new-open", rolled, "-1", "60", 3, "open"),
        rawDateTime: newCallTime,
      },
    ],
  ]);
  const initial = projectLifecycles(ledger, projection, []);
  const old = initial.suggestions.find(
    (s) => s.callOpening.executionKey === "old-open",
  );
  const target = old?.candidateLifecycleIds[0];
  if (!old || !target) throw Error("Missing old call connection");
  const oldMembers = initial.members.filter(
    (m) => m.allocation.strategyId === "old",
  );
  const confirmed: Decision = {
    id: "connect-old",
    sequence: 1,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    kind: "lifecycle_membership",
    payload: {
      requireCallCoverage: true,
      assignments: oldMembers.map((m) => ({
        allocation: m.allocation,
        lifecycleId: target,
        quantity: m.quantity,
      })),
    },
  };
  const after = projectLifecycles(ledger, projection, [confirmed]);
  return {
    target,
    next: after.suggestions.find(
      (s) => s.callOpening.executionKey === "new-open",
    ),
  };
}

it("frees shares for a call sold in the same instant the covered call is bought back", () => {
  const { target, next } = rollAt("2026-10-03T10:44:19Z");
  expect(next?.reasons).not.toContain("SHARES_RESERVED_BY_OTHER_CALLS");
  expect(next?.candidateLifecycleIds).toEqual([target]);
});

it("treats a legged roll as covered: old call bought back later the same day", () => {
  // SOFI 2025-02-11: new call sold 09:48, old call bought back 10:27.
  const { target, next } = rollAt("2026-10-03T09:48:12Z", {
    day: 3,
    time: "2026-10-03T10:27:19Z",
  });
  expect(next?.reasons).not.toContain("SHARES_RESERVED_BY_OTHER_CALLS");
  expect(next?.candidateLifecycleIds).toEqual([target]);
});

it("still blocks when the old call is only bought back on a later day", () => {
  const { next } = rollAt("2026-10-03T09:48:12Z", {
    day: 4,
    time: "2026-10-04T10:27:19Z",
  });
  expect(next?.candidateLifecycleIds).toEqual([]);
  expect(next?.reasons).toContain("SHARES_RESERVED_BY_OTHER_CALLS");
});

it("still blocks when the old call expires that day instead of being bought back", () => {
  // FIG 2025-11-07: new call sold in the morning, old call expired at 16:20.
  const { next } = rollAt("2026-10-03T09:48:22Z", {
    day: 3,
    time: "2026-10-03T16:20:00Z",
    event: "expiry",
  });
  expect(next?.candidateLifecycleIds).toEqual([]);
  expect(next?.reasons).toContain("SHARES_RESERVED_BY_OTHER_CALLS");
});

it("does not treat it as a legged roll when another call is sold after the buy-back", () => {
  // SOFI 2025-02-11: 18.5C sold 09:48, old 16.5C bought back 10:27, and a new
  // 16.5C sold 10:28. The 10:28 call is the real roll; the 09:48 call is not.
  const later = { ...call, key: "later-call", conid: "6" };
  const { next } = rollAt(
    "2026-10-03T09:48:12Z",
    { day: 3, time: "2026-10-03T10:27:19Z" },
    [
      [
        "later",
        {
          ...execution("later-open", later, "-1", "33", 3, "open"),
          rawDateTime: "2026-10-03T10:28:11Z",
        },
      ],
    ],
  );
  expect(next?.candidateLifecycleIds).toEqual([]);
  expect(next?.reasons).toContain("SHARES_RESERVED_BY_OTHER_CALLS");
});

it("does not treat it as a legged roll when the shares are sold that day", () => {
  // NVDA 2025-05-13: old call bought back and the shares sold; that is an
  // exit, so the call sold earlier that day was left uncovered.
  const { next } = rollAt(
    "2026-10-03T10:20:50Z",
    { day: 3, time: "2026-10-03T10:24:25Z" },
    [
      [
        "shares",
        {
          ...execution("share-sale", stock, "-100", "12900", 3, "close"),
          rawDateTime: "2026-10-03T10:24:25Z",
        },
      ],
    ],
  );
  expect(next?.candidateLifecycleIds).toEqual([]);
});

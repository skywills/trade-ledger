import { expect, it } from "vitest";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import {
  connectionGroups,
  connectionProposal,
  connectionTimeline,
  tradeActionLabel,
} from "../../src/web/lifecycles/connections.js";
import {
  call,
  execution,
  fixture,
  put,
  stock,
} from "../fixtures/lifecycles.js";

function reviewFixture() {
  const f = fixture([
    ["shares", execution("shares", stock, "200", "-10000", 1, "open")],
    ["calls", execution("call-1", call, "-1", "70", 2, "open")],
    ["calls", execution("call-2", call, "-1", "75", 2, "open")],
    ["calls", execution("close-1", call, "1", "-80", 3, "close")],
    ["calls", execution("close-2", call, "1", "-90", 3, "close")],
  ]);
  const p = projectLifecycles(f.ledger, f.projection, []);
  return { ...f, p };
}
it("groups fills of one call contract into one decision and includes every whole close", () => {
  const { ledger, p } = reviewFixture();
  const groups = connectionGroups(p.suggestions, p.members, ledger.executions);
  expect(groups).toHaveLength(1);
  const group = groups[0];
  if (!group) throw new Error("Missing connection group");
  expect(group).toMatchObject({ contracts: "2", shares: "200" });
  const draft = connectionProposal(group, "share-owner");
  expect(draft.payload).toMatchObject({ requireCallCoverage: true });
  expect(
    draft.payload.assignments
      .map((a) => [a.allocation.executionKey, a.quantity, a.lifecycleId])
      .sort(),
  ).toEqual([
    ["call-1", "-1", "share-owner"],
    ["call-2", "-1", "share-owner"],
    ["close-1", "1", "share-owner"],
    ["close-2", "1", "share-owner"],
  ]);
  const separate = connectionProposal(group, "", true);
  expect(separate.payload.requireCallCoverage).toBe(false);
  expect(
    separate.payload.assignments.every(
      (a) => a.lifecycleId === group.members[0]?.lifecycleId,
    ),
  ).toBe(true);
});
it("requires individual review when one opening already has a retained decision", () => {
  const { ledger, p } = reviewFixture();
  const groups = connectionGroups(
    p.suggestions.slice(0, 1),
    p.members,
    ledger.executions,
  );
  expect(groups[0]?.canReviewWhole).toBe(false);
});
it("keeps different call contracts separate even inside one presentation component", () => {
  const { ledger, p } = reviewFixture();
  const second = ledger.executions.find((e) => e.key === "call-2");
  if (second)
    second.instrument = { ...call, key: "different-call", strike: "110" };
  const groups = connectionGroups(p.suggestions, p.members, ledger.executions);
  expect(groups).toHaveLength(2);
  expect(groups.map((g) => g.contracts)).toEqual(["1", "1"]);
});

it("preserves provable ordering even when an uncertain trade separates comparable rows", () => {
  const { p } = reviewFixture();
  const executions = [
    {
      ...execution("late", call, "-1", "70", 2, "open"),
      rawDateTime: "2026-10-02T11:00:00Z",
    },
    {
      ...execution("unknown", call, "-1", "70", 2, "open"),
      rawDateTime: "2026-10-02",
      timezone: null,
    },
    {
      ...execution("early", stock, "100", "-10000", 2, "open"),
      rawDateTime: "2026-10-02T12:00:00+02:00",
    },
  ];
  const members = p.members.slice(0, 3).map((m, i) => ({
    ...m,
    allocation: { ...m.allocation, executionKey: executions[i]?.key ?? "" },
  }));
  const timeline = connectionTimeline(members, executions);
  expect(timeline.uncertain).toBe(true);
  expect(timeline.rows.map((m) => m.allocation.executionKey)).toEqual([
    "unknown",
    "early",
    "late",
  ]);
  expect(connectionTimeline(members, []).rows).toEqual(members);
  expect(connectionTimeline(members, []).uncertain).toBe(true);
});

it("distinguishes assignment from buying an option back in the review timeline", () => {
  expect(
    tradeActionLabel(
      execution("assignment", put, "1", "0", 2, "close", "assignment"),
      "1",
      "close",
    ),
  ).toBe("Puts assigned");
  expect(
    tradeActionLabel(
      execution(
        "stock-assignment",
        stock,
        "100",
        "-10000",
        2,
        "open",
        "assignment",
      ),
      "100",
      "open",
    ),
  ).toBe("Acquired shares through assignment");
  expect(
    tradeActionLabel(
      execution("call-close", call, "1", "-80", 3, "close"),
      "1",
      "close",
    ),
  ).toBe("Bought back calls");
});

it("reviews connections by their earliest call transaction date regardless of input order", () => {
  const laterCall = { ...call, key: "later-call", conid: "4" };
  const earliestCall = { ...call, key: "earliest-call", conid: "5" };
  const { ledger, projection } = fixture([
    ["shares", execution("shares", stock, "400", "-40000", 1, "open")],
    ["later", execution("later", laterCall, "-1", "70", 9, "open")],
    ["fills", execution("second-fill", call, "-1", "70", 7, "open")],
    ["earliest", execution("earliest", earliestCall, "-1", "70", 2, "open")],
    ["fills", execution("first-fill", call, "-1", "70", 3, "open")],
  ]);
  const p = projectLifecycles(ledger, projection, []);
  const suggestions = ["later", "second-fill", "earliest", "first-fill"].map(
    (key) => {
      const suggestion = p.suggestions.find(
        (s) => s.callOpening.executionKey === key,
      );
      if (!suggestion) throw new Error(`Missing suggestion ${key}`);
      return suggestion;
    },
  );
  const groups = connectionGroups(suggestions, p.members, ledger.executions);
  expect(groups.map((g) => g.instrument.key)).toEqual([
    "earliest-call",
    "call",
    "later-call",
  ]);
  expect(groups[1]?.suggestions.map((s) => s.callOpening.executionKey)).toEqual(
    ["first-fill", "second-fill"],
  );
  expect(suggestions[0]?.callOpening.executionKey).toBe("later");
});

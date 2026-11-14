import { describe, expect, it } from "vitest";
import { groupReviewIssues } from "../../src/server/review/group-issues.js";
import type { Issue, ReconciliationContext } from "../../src/shared/domain.js";

const context = (
  id: string,
  kind: "strategy" | "lifecycle",
  executionKey = "e1",
): ReconciliationContext => ({
  version: 1,
  owners: [{ kind, id }],
  slices: [{ executionKey, role: "open", quantity: "1", netCash: "-2" }],
  currency: "USD",
  brokerPnl: "1",
  reconstructedPnl: "2",
});
const issue = (
  key: string,
  reconciliation = context(key, "strategy"),
): Issue => ({
  key,
  code: "PNL_RECONCILIATION",
  severity: "warning",
  sources: [{ importId: "i", rowNumber: 1 }],
  reconciliation,
});

describe("groupReviewIssues", () => {
  it("groups equivalent findings deterministically, preserving keys, owners and sources", () => {
    const a = issue("strategy:a");
    const b = issue("lifecycle:a", {
      ...context("a", "lifecycle"),
      brokerPnl: "1.0",
      slices: [
        { executionKey: "e1", role: "open", quantity: "1.00", netCash: "-2.0" },
      ],
    });
    b.sources.push({ importId: "i", rowNumber: 2 });
    const c = issue("strategy:b", context("b", "strategy", "e2"));
    const d = issue("lifecycle:b", context("b", "lifecycle", "e2"));
    const result = groupReviewIssues([a, b, c, d]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(groupReviewIssues([d, c, b, a]));
    expect(result[0]).toMatchObject({
      key: "lifecycle:a",
      issueKeys: ["lifecycle:a", "strategy:a"],
      owners: [
        { kind: "lifecycle", id: "a" },
        { kind: "strategy", id: "strategy:a" },
      ],
      sources: [
        { importId: "i", rowNumber: 1 },
        { importId: "i", rowNumber: 2 },
      ],
    });
  });

  it("keeps different evidence and context-free or non-PNL issues separate", () => {
    const base = issue("a");
    const variants: Issue[] = [
      issue("b", { ...context("b", "strategy"), currency: "EUR" }),
      { ...issue("c"), severity: "error" },
      issue("d", { ...context("d", "strategy"), brokerPnl: "3" }),
      issue("e", { ...context("e", "strategy"), reconstructedPnl: "3" }),
      issue("f", context("f", "strategy", "other")),
      issue("g", {
        ...context("g", "strategy"),
        slices: [
          ...context("g", "strategy").slices,
          ...context("g", "strategy").slices,
        ],
      }),
      {
        key: "h",
        code: "PNL_RECONCILIATION",
        severity: "warning",
        sources: [],
      },
      {
        key: "i",
        code: "PNL_RECONCILIATION",
        severity: "warning",
        sources: [],
      },
      { ...issue("j"), code: "OTHER" },
      { ...issue("k"), code: "OTHER" },
    ];
    expect(groupReviewIssues([base, ...variants])).toHaveLength(11);
    expect(groupReviewIssues(variants.slice(6, 7))[0]).toMatchObject({
      issueKeys: ["h"],
      owners: [],
    });
  });
});

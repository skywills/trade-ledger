import { Decimal } from "decimal.js";
import { expect, it } from "vitest";
import { accountLifecycles } from "../../src/server/lifecycles/accounting.js";
import { projectLifecycles } from "../../src/server/lifecycles/project.js";
import { groupReviewIssues } from "../../src/server/review/group-issues.js";
import { accountProjection } from "../../src/server/strategies/accounting.js";
import { futuresSpread } from "../fixtures/futures-pnl.js";
import { execution, fixture, put } from "../fixtures/lifecycles.js";

it("retains the option owner pair when futures cash reconstruction is corrected", () => {
  const futures = futuresSpread("mtm-gap").map((row) => row.execution);
  const open = execution("option-open", put, "-1", "139.6558602", 1, "open");
  const close = execution("option-close", put, "1", "-53.10225", 2, "close");
  close.basis = "139.65586";
  close.brokerPnl = "86.53261";

  function findings(simulateOldCashCalculation: boolean) {
    const f = fixture([
      ...structuredClone(futures).map((row): [string, typeof row] => [
        "future",
        row,
      ]),
      ["option", structuredClone(open)],
      ["option", structuredClone(close)],
    ]);
    for (const strategy of f.projection.strategies) strategy.status = "closed";
    const lifecycles = projectLifecycles(f.ledger, f.projection, []);
    for (const lifecycle of lifecycles.lifecycles) {
      lifecycle.status = "closed";
      lifecycle.complete = true;
    }
    // The old algorithm summed net cash for futures, as the ordinary-asset
    // branch still does. Change only the cloned calculation input to emulate it.
    if (simulateOldCashCalculation) {
      for (const row of f.ledger.executions)
        if (row.instrument.assetClass === "FUT")
          row.instrument.assetClass = "STK";
    }
    const strategies = accountProjection(f.ledger, f.projection);
    const cycles = accountLifecycles(f.ledger, f.projection, lifecycles);
    return [...strategies.issues, ...cycles.issues].filter(
      (issue) => issue.code === "PNL_RECONCILIATION",
    );
  }

  const before = findings(true);
  expect(before).toHaveLength(4);
  expect(groupReviewIssues(before)).toHaveLength(2);
  const after = findings(false);
  expect(after).toHaveLength(2);
  const entries = groupReviewIssues(after);
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  expect(entry?.issueKeys).toHaveLength(2);
  expect(entry?.owners.map((owner) => owner.kind).sort()).toEqual([
    "lifecycle",
    "strategy",
  ]);
  expect(entry?.reconciliation).toMatchObject({
    brokerPnl: "86.53261",
    reconstructedPnl: "86.5536102",
  });
  if (!entry?.reconciliation) throw new Error("Missing reconciliation");
  expect(
    new Decimal(entry.reconciliation.reconstructedPnl)
      .minus(entry.reconciliation.brokerPnl)
      .toString(),
  ).toBe("0.0210002");
});

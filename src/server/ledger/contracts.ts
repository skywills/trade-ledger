import { Decimal } from "decimal.js";
import type { Execution, Issue } from "../../shared/domain.js";
import { makeIssue } from "../imports/normalization.js";

/** Only active, identity-resolved rows may supply evidence for other rows. */
export function resolveContractMultipliers(
  executions: Execution[],
  issues: Issue[],
): void {
  const contracts = new Map<string, Execution[]>();
  const fallbackKey = (execution: Execution): string | null => {
    const i = execution.instrument;
    if (
      i.expiry === null ||
      (i.assetClass === "OPT" && (i.strike === null || i.putCall === null))
    )
      return null;
    return JSON.stringify([
      execution.account,
      execution.currency,
      i.assetClass,
      i.symbol,
      i.underlying,
      i.expiry,
      i.strike === null ? null : new Decimal(i.strike).toFixed(),
      i.putCall,
    ]);
  };
  const knownIds = new Map<string, Set<string>>();
  for (const execution of executions) {
    const fallback = fallbackKey(execution);
    const conid = execution.instrument.conid;
    if (fallback === null || conid === null) continue;
    const ids = knownIds.get(fallback) ?? new Set<string>();
    ids.add(conid);
    knownIds.set(fallback, ids);
  }
  for (const execution of executions) {
    const instrument = execution.instrument;
    if (instrument.assetClass !== "OPT" && instrument.assetClass !== "FUT")
      continue;
    const fallback = fallbackKey(execution);
    if (instrument.conid === null && fallback === null) continue;
    const ids = fallback === null ? undefined : knownIds.get(fallback);
    const conid = instrument.conid ?? (ids?.size === 1 ? [...ids][0] : null);
    if (instrument.conid === null && conid) {
      // Canonical exposure keys must agree as well as matching metadata.
      execution.instrument = { ...instrument, conid, key: `conid:${conid}` };
    }
    const identity = conid ? `conid:${conid}` : fallback;
    const key = JSON.stringify([
      execution.account,
      execution.currency,
      instrument.assetClass,
      identity,
    ]);
    const rows = contracts.get(key) ?? [];
    rows.push(execution);
    contracts.set(key, rows);
  }
  const resolvedSources = new Set<string>();
  for (const rows of contracts.values()) {
    const values = new Set(
      rows.flatMap((row) =>
        row.instrument.multiplier === null
          ? []
          : [new Decimal(row.instrument.multiplier).toFixed()],
      ),
    );
    if (values.size > 1) {
      for (const row of rows)
        for (const source of row.sources) {
          issues.push(makeIssue("conflicting_multiplier", source, "warning"));
        }
      continue;
    }
    const value = [...values][0];
    if (value === undefined) continue;
    for (const row of rows) {
      if (row.instrument.multiplier === null)
        row.instrument = { ...row.instrument, multiplier: value };
      for (const source of row.sources)
        resolvedSources.add(
          JSON.stringify([source.importId, source.rowNumber]),
        );
    }
  }
  // Replace obsolete row-local warnings only for the rows actually resolved.
  for (let index = issues.length - 1; index >= 0; index--) {
    const issue = issues[index];
    if (
      issue?.code === "missing_multiplier" &&
      issue.sources.every((source) =>
        resolvedSources.has(
          JSON.stringify([source.importId, source.rowNumber]),
        ),
      )
    )
      issues.splice(index, 1);
  }
}

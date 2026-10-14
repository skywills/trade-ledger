import type { Execution } from "../api.js";

/**
 * Distinct, sorted contract expiry dates behind a strategy's allocations.
 * Null expiries (shares, unknown contracts) are omitted so a mixed strategy
 * never renders a blank entry.
 */
export function collectActualExpiries(
  executionKeys: readonly string[],
  executionByKey: ReadonlyMap<string, Execution>,
): string[] {
  const expiries = new Set<string>();
  for (const key of executionKeys) {
    const expiry = executionByKey.get(key)?.instrument.expiry;
    if (expiry !== null && expiry !== undefined) expiries.add(expiry);
  }
  return [...expiries].sort();
}

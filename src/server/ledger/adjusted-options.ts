import { Decimal } from "decimal.js";
import type { Execution } from "../../shared/domain.js";
import { compareExecutionTime } from "../../shared/execution-chronology.js";

/**
 * After a reverse split (or similar corporate action) the options exchange
 * renames outstanding option contracts, e.g. SQQQ -> SQQQ2, with a new conid.
 * IBKR does not report this as a corporate action for an account that held
 * only the options, so the adjusted contract first appears as a close (often
 * an expiry) with no opening. Map such rows back onto the original contract
 * only when the trades prove the continuity:
 * - same account, currency, expiry, strike and right on the base root;
 * - the adjusted contract never opened under its own symbol;
 * - the original is still open, opposite in sign, covering every adjusted close;
 * - the original never trades again once the adjusted contract appears.
 * Returns the keys of the remapped executions. Mutates their instrument.
 */
export function resolveAdjustedOptionRoots(executions: Execution[]): string[] {
  const contractOf = (e: Execution, root: string) =>
    JSON.stringify([
      e.account,
      e.currency,
      root,
      e.instrument.expiry,
      e.instrument.strike === null
        ? null
        : new Decimal(e.instrument.strike).toFixed(),
      e.instrument.putCall,
    ]);
  const options = executions.filter(
    (e) =>
      e.instrument.assetClass === "OPT" &&
      e.instrument.underlying !== null &&
      e.instrument.expiry !== null &&
      e.instrument.strike !== null &&
      e.instrument.putCall !== null,
  );
  const byInstrument = new Map<string, Execution[]>();
  for (const e of options) {
    const rows = byInstrument.get(e.instrument.key) ?? [];
    rows.push(e);
    byInstrument.set(e.instrument.key, rows);
  }
  const baseContracts = new Map<string, Set<string>>();
  for (const e of options) {
    const id = contractOf(e, e.instrument.underlying ?? "");
    const keys = baseContracts.get(id) ?? new Set<string>();
    keys.add(e.instrument.key);
    baseContracts.set(id, keys);
  }
  const mapped: string[] = [];
  for (const [key, rows] of byInstrument) {
    const first = rows[0];
    const root = /^(.+?)\d$/.exec(first?.instrument.underlying ?? "")?.[1];
    if (!first || !root) continue;
    const baseKeys = [...(baseContracts.get(contractOf(first, root)) ?? [])];
    const baseKey = baseKeys.length === 1 ? baseKeys[0] : undefined;
    const baseRows = baseKey ? byInstrument.get(baseKey) : undefined;
    if (!baseKey || baseKey === key || !baseRows?.length) continue;
    if (!adjustedFromBase(rows, baseRows)) continue;
    const instrument = baseRows[0]?.instrument;
    if (!instrument) continue;
    for (const row of rows) {
      row.instrument = { ...instrument };
      mapped.push(row.key);
    }
  }
  return mapped;
}

function adjustedFromBase(adjusted: Execution[], base: Execution[]): boolean {
  const earliest = (rows: Execution[]) =>
    rows.reduce<Execution | null>((min, row) => {
      if (min === null) return row;
      const order = compareExecutionTime(row, min);
      return order !== null && order < 0 ? row : min;
    }, null);
  const start = earliest(adjusted);
  if (start?.action !== "close") return false;
  // Every adjusted row must be a close, and none may predate the rename point.
  if (adjusted.some((row) => row.action !== "close")) return false;
  let open = new Decimal(0);
  for (const row of base) {
    const order = compareExecutionTime(row, start);
    if (order === null) return false;
    if (order >= 0) return false; // the original keeps trading afterwards
    open = open.plus(row.quantity);
  }
  const closing = adjusted.reduce(
    (sum, row) => sum.plus(row.quantity),
    new Decimal(0),
  );
  return (
    !open.isZero() &&
    !closing.isZero() &&
    open.isNegative() !== closing.isNegative() &&
    open.abs().gte(closing.abs())
  );
}

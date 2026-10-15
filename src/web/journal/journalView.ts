/** Pure filter/sort helpers for the journal table (no React, no I/O). */

export type SortKey =
  | "openingDate"
  | "closeDate"
  | "status"
  | "expiry"
  | "description"
  | "openingAmount"
  | "brokerPnl"
  | "reconstructedPnl";

export type SortDirection = "asc" | "desc";

export interface SortState {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

export interface JournalFilters {
  readonly currency: string;
  readonly status: string;
  readonly query: string;
}

export interface JournalRowLike {
  readonly description: string;
  readonly currency: string;
  readonly status: string;
  readonly openingDate: string | null;
  readonly closeDate: string | null;
  readonly expiry: string | null;
  readonly openingAmount: string | null;
  readonly brokerPnl: string | null;
  readonly reconstructedPnl: string | null;
}

const NUMERIC_KEYS: ReadonlySet<SortKey> = new Set([
  "openingAmount",
  "brokerPnl",
  "reconstructedPnl",
]);

export function filterStrategies<T extends JournalRowLike>(
  rows: readonly T[],
  filters: JournalFilters,
): T[] {
  const query = filters.query.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (filters.currency === "" || row.currency === filters.currency) &&
      (filters.status === "" || row.status === filters.status) &&
      (query === "" || row.description.toLowerCase().includes(query)),
  );
}

function compareValues(key: SortKey, a: string, b: string): number {
  if (NUMERIC_KEYS.has(key)) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isNaN(left) && !Number.isNaN(right)) return left - right;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Returns a new array. Null values always sort last, in both directions. */
export function sortStrategies<T extends JournalRowLike>(
  rows: readonly T[],
  sort: SortState | null,
): T[] {
  if (sort === null) return [...rows];
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left[sort.key];
    const b = right[sort.key];
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return sign * compareValues(sort.key, a, b);
  });
}

/** Header click cycle: none -> ascending -> descending -> none. */
export function nextSort(
  current: SortState | null,
  key: SortKey,
): SortState | null {
  if (current === null || current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return null;
}

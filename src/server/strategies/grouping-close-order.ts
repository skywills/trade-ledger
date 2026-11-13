import type { Execution } from "../../shared/domain.js";
import { compareExecutionTime } from "../ledger/chronology.js";
import { sortedByKey } from "./grouping-common.js";

/** Above this many closes the n² edge bitset would exceed 8 MiB. */
const MAX_BITSET_EXECUTIONS = 8192;

function precedes(left: Execution, right: Execution): boolean {
  const chronology = compareExecutionTime(left, right);
  if (chronology === null) return false;
  return chronology === 0 ? left.key < right.key : chronology < 0;
}

/** Min-heap of execution indexes ordered by key. */
class KeyHeap {
  private readonly items: number[] = [];
  constructor(private readonly keyOf: (index: number) => string) {}
  get size(): number {
    return this.items.length;
  }
  private less(a: number, b: number): boolean {
    return this.keyOf(a) < this.keyOf(b);
  }
  push(item: number): void {
    const items = this.items;
    let index = items.length;
    items.push(item);
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = items[parentIndex] as number;
      if (!this.less(item, parent)) break;
      items[index] = parent;
      index = parentIndex;
    }
    items[index] = item;
  }
  pop(): number | undefined {
    const items = this.items;
    const first = items[0];
    const last = items.pop();
    if (first === undefined || last === undefined || items.length === 0)
      return first;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= items.length) break;
      const rightIndex = leftIndex + 1;
      const childIndex =
        rightIndex < items.length &&
        this.less(items[rightIndex] as number, items[leftIndex] as number)
          ? rightIndex
          : leftIndex;
      const child = items[childIndex] as number;
      if (!this.less(child, last)) break;
      items[index] = child;
      index = childIndex;
    }
    items[index] = last;
    return first;
  }
}

/**
 * Orders known chronological constraints without treating uncertain pairs as
 * pairwise key comparisons. A stable topological ordering is transitive even
 * when some executions cannot be compared safely. Ready executions leave in
 * key order, so the result is the key-smallest valid order.
 *
 * Each pair is compared once and the resulting edges kept in an n² bitset;
 * the pairwise scan below recomputes them and is kept for inputs too large
 * for the bitset or with duplicate keys.
 */
export function orderByKnownChronology(
  executions: readonly Execution[],
): Execution[] {
  const n = executions.length;
  if (
    n > MAX_BITSET_EXECUTIONS ||
    new Set(executions.map((e) => e.key)).size !== n
  )
    return orderByPairwiseScan(executions);
  const words = Math.ceil(n / 32);
  const edges = new Uint32Array(n * words);
  const indegree = new Uint32Array(n);
  const setEdge = (from: number, to: number): void => {
    const word = from * words + (to >>> 5);
    edges[word] = (edges[word] as number) | (1 << (to & 31));
    indegree[to] = (indegree[to] as number) + 1;
  };
  for (let i = 0; i < n; i += 1) {
    const left = executions[i] as Execution;
    for (let j = i + 1; j < n; j += 1) {
      const right = executions[j] as Execution;
      // compareExecutionTime is antisymmetric, so one call settles both
      // directions: exactly one of precedes(left,right)/(right,left) holds
      // when the pair is comparable.
      const chronology = compareExecutionTime(left, right);
      if (chronology === null) continue;
      const leftFirst =
        chronology === 0 ? left.key < right.key : chronology < 0;
      if (leftFirst) setEdge(i, j);
      else setEdge(j, i);
    }
  }
  const ready = new KeyHeap((index) => (executions[index] as Execution).key);
  for (let i = 0; i < n; i += 1) if (indegree[i] === 0) ready.push(i);
  const ordered: Execution[] = [];
  while (ready.size > 0) {
    const from = ready.pop() as number;
    ordered.push(executions[from] as Execution);
    const row = from * words;
    for (let w = 0; w < words; w += 1) {
      let bits = edges[row + w] as number;
      while (bits !== 0) {
        const low = bits & -bits;
        const to = w * 32 + (31 - Math.clz32(low));
        bits ^= low;
        const remaining = (indegree[to] as number) - 1;
        indegree[to] = remaining;
        if (remaining === 0) ready.push(to);
      }
    }
  }
  // Pairwise time evidence should be acyclic. In case malformed provenance
  // ever creates a cycle, keep the entire close set deterministic and let the
  // exposure guard prevent a consumed opening from being reused.
  return ordered.length === n ? ordered : sortedByKey(executions);
}

/**
 * The original pairwise-scan ordering with linear auxiliary memory. Same
 * result as `orderByKnownChronology`, recomputing each comparison twice.
 */
export function orderByPairwiseScan(
  executions: readonly Execution[],
): Execution[] {
  const indegree = new Map<string, number>();
  for (const execution of executions) {
    indegree.set(execution.key, 0);
  }

  // Count incoming constraints without retaining the pairwise graph. The
  // quadratic comparison cost is bounded by the close count, while auxiliary
  // memory stays linear instead of growing with the number of comparable pairs.
  for (let leftIndex = 0; leftIndex < executions.length; leftIndex += 1) {
    const left = executions[leftIndex];
    if (left === undefined) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < executions.length;
      rightIndex += 1
    ) {
      const right = executions[rightIndex];
      if (right === undefined) continue;
      if (precedes(left, right)) {
        indegree.set(right.key, (indegree.get(right.key) ?? 0) + 1);
      } else if (precedes(right, left)) {
        indegree.set(left.key, (indegree.get(left.key) ?? 0) + 1);
      }
    }
  }

  const byKey = new Map(
    executions.map((execution) => [execution.key, execution]),
  );
  const ready: string[] = [];
  const pushReady = (key: string): void => {
    let index = ready.length;
    ready.push(key);
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const parent = ready[parentIndex];
      if (parent === undefined || parent <= key) break;
      ready[index] = parent;
      index = parentIndex;
    }
    ready[index] = key;
  };
  const popReady = (): string | undefined => {
    const first = ready[0];
    const last = ready.pop();
    if (first === undefined || last === undefined || ready.length === 0)
      return first;
    let index = 0;
    while (true) {
      const leftIndex = index * 2 + 1;
      if (leftIndex >= ready.length) break;
      const rightIndex = leftIndex + 1;
      const childIndex =
        rightIndex < ready.length &&
        (ready[rightIndex] ?? "") < (ready[leftIndex] ?? "")
          ? rightIndex
          : leftIndex;
      const child = ready[childIndex];
      if (child === undefined || child >= last) break;
      ready[index] = child;
      index = childIndex;
    }
    ready[index] = last;
    return first;
  };
  for (const execution of executions) {
    if (indegree.get(execution.key) === 0) pushReady(execution.key);
  }
  const pending = new Set(executions.map((execution) => execution.key));
  const ordered: Execution[] = [];
  while (ready.length > 0) {
    const key = popReady();
    if (key === undefined) continue;
    const execution = byKey.get(key);
    if (execution !== undefined) ordered.push(execution);
    pending.delete(key);
    if (execution === undefined) continue;
    for (const next of pending) {
      const nextExecution = byKey.get(next);
      if (nextExecution === undefined || !precedes(execution, nextExecution))
        continue;
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) pushReady(next);
    }
  }

  // Pairwise time evidence should be acyclic. In case malformed provenance
  // ever creates a cycle, keep the entire close set deterministic and let the
  // exposure guard below prevent a consumed opening from being reused.
  return ordered.length === executions.length
    ? ordered
    : sortedByKey(executions);
}

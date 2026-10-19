import type { Execution } from "../../shared/domain.js";
import { compareExecutionTime } from "../ledger/chronology.js";
import { sortedByKey } from "./grouping-common.js";

/**
 * Orders known chronological constraints without treating uncertain pairs as
 * pairwise key comparisons. A stable topological ordering is transitive even
 * when some executions cannot be compared safely.
 */
export function orderByKnownChronology(
  executions: readonly Execution[],
): Execution[] {
  const indegree = new Map<string, number>();
  for (const execution of executions) {
    indegree.set(execution.key, 0);
  }

  const precedes = (left: Execution, right: Execution): boolean => {
    const chronology = compareExecutionTime(left, right);
    if (chronology === null) return false;
    return chronology === 0 ? left.key < right.key : chronology < 0;
  };

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

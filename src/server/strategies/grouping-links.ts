import type { Execution, Id, SourceRef } from "../../shared/domain.js";
import {
  groupKeyOf,
  type LifecycleInstruction,
  type Link,
  sortedByKey,
  sourceKey,
} from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { validateLifecycle } from "./lifecycle.js";
import { isDerivative } from "./matching.js";
import { makeIssue } from "./projection.js";

function lifecycleEventFor(group: readonly Execution[]): string {
  for (const event of ["assignment", "exercise", "expiry", "cash_settlement"]) {
    if (group.some((execution) => execution.event === event)) return event;
  }
  return "assignment";
}

export function buildGroupingLinks(
  context: GroupingContext,
  lifecycles: readonly LifecycleInstruction[],
  orderOpenings: ReadonlyMap<string, Id>,
  orderedCloseExecutions: readonly Execution[],
): Link[] {
  const { ledger, drafts, executionBySource, resolveId, addIssue } = context;
  const strategyOfExecution = new Map<Id, Id>();
  for (const draft of drafts.values()) {
    for (const allocation of draft.allocations) {
      strategyOfExecution.set(allocation.executionKey, draft.id);
    }
  }

  const links: Link[] = [];
  const linkKeys = new Set<string>();
  const addLink = (
    from: Id,
    to: Id,
    type: string,
    sources: SourceRef[],
  ): void => {
    if (from === to) return;
    const key = `${from}|${to}|${type}`;
    if (linkKeys.has(key)) return;
    linkKeys.add(key);
    links.push({ from, to, type, sources });
  };

  // 5. Assignment/exercise links from the retained PositionActionID.
  const byAction = new Map<string, Execution[]>();
  for (const execution of ledger.executions) {
    const actionId = execution.brokerIds.PositionActionID;
    if (actionId === undefined) continue;
    const group = byAction.get(actionId) ?? [];
    group.push(execution);
    byAction.set(actionId, group);
  }
  for (const actionId of [...byAction.keys()].sort()) {
    const group = sortedByKey(byAction.get(actionId) ?? []);
    const option = group.find((execution) =>
      isDerivative(execution.instrument),
    );
    const stock = group.find(
      (execution) => !isDerivative(execution.instrument),
    );
    if (option === undefined || stock === undefined) continue;
    const event = lifecycleEventFor(group);
    const issue = validateLifecycle(event, option, stock);
    if (issue !== null) {
      addIssue(issue);
      continue;
    }
    const from = strategyOfExecution.get(option.key);
    const to = strategyOfExecution.get(stock.key);
    if (from === undefined || to === undefined) continue;
    addLink(from, to, event, [...option.sources, ...stock.sources]);
  }

  // 6. User lifecycle corrections, validated before linking.
  for (const instruction of lifecycles) {
    const source = executionBySource.get(sourceKey(instruction.source));
    const target = executionBySource.get(sourceKey(instruction.target));
    if (source === undefined || target === undefined) {
      addIssue(
        makeIssue(
          "LIFECYCLE_INCONSISTENT",
          instruction.sources,
          "error",
          `${sourceKey(instruction.source)}:missing`,
        ),
      );
      continue;
    }
    const issue = validateLifecycle(instruction.event, source, target);
    if (issue !== null) {
      addIssue(issue);
      continue;
    }
    const from =
      strategyOfExecution.get(source.key) ??
      resolveId(source.account, [source.key]);
    const to =
      strategyOfExecution.get(target.key) ??
      resolveId(target.account, [target.key]);
    addLink(from, to, instruction.event, [
      ...source.sources,
      ...target.sources,
    ]);
  }

  // 7. Rolls: an order holding both a close and an open leg links the two
  //    episodes without merging their allocations or P/L.
  const orderCloses = new Map<string, Id>();
  for (const close of orderedCloseExecutions) {
    const key = groupKeyOf(close);
    if (!orderOpenings.has(key)) continue;
    const closeDraftId = strategyOfExecution.get(close.key);
    if (closeDraftId !== undefined) orderCloses.set(key, closeDraftId);
  }
  for (const key of [...orderCloses.keys()].sort()) {
    const openDraftId = orderOpenings.get(key);
    const closeDraftId = orderCloses.get(key);
    if (openDraftId === undefined || closeDraftId === undefined) continue;
    const sources = ledger.executions
      .filter((execution) => groupKeyOf(execution) === key)
      .flatMap((execution) => execution.sources);
    addLink(closeDraftId, openDraftId, "roll", sources);
  }
  return links;
}

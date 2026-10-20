import type { Execution, Id, SourceRef } from "../../shared/domain.js";
import {
  groupKeyOf,
  type LifecycleInstruction,
  type Link,
  sortedByKey,
  sourceKey,
} from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { looksLikeBookedEvent, validateLifecycle } from "./lifecycle.js";
import { isDerivative } from "./matching.js";
import { makeIssue, pushDraftIssue } from "./projection.js";

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
  const strategiesOfExecution = new Map<Id, Set<Id>>();
  for (const draft of drafts.values()) {
    for (const allocation of draft.allocations) {
      const owners =
        strategiesOfExecution.get(allocation.executionKey) ?? new Set<Id>();
      owners.add(draft.id);
      strategiesOfExecution.set(allocation.executionKey, owners);
    }
  }

  const links: Link[] = [];
  const resolvedEvents = new Set<Id>();
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
    resolvedEvents.add(option.key);
    resolvedEvents.add(stock.key);
    const from = strategiesOfExecution.get(option.key) ?? [];
    const to = strategiesOfExecution.get(stock.key) ?? [];
    for (const source of from)
      for (const target of to)
        addLink(source, target, event, [...option.sources, ...stock.sources]);
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
    if (instruction.event !== "roll") {
      resolvedEvents.add(source.key);
      resolvedEvents.add(target.key);
    }
    const from =
      strategiesOfExecution.get(source.key) ??
      new Set([resolveId(source.account, [source.key])]);
    const to =
      strategiesOfExecution.get(target.key) ??
      new Set([resolveId(target.account, [target.key])]);
    for (const sourceId of from)
      for (const targetId of to)
        addLink(sourceId, targetId, instruction.event, [
          ...source.sources,
          ...target.sources,
        ]);
  }

  // 7. Rolls: an order holding both a close and an open leg links the two
  //    episodes without merging their allocations or P/L.
  const orderCloses = new Map<string, Set<Id>>();
  for (const close of orderedCloseExecutions) {
    const key = groupKeyOf(close);
    if (!orderOpenings.has(key)) continue;
    const owners = orderCloses.get(key) ?? new Set<Id>();
    for (const id of strategiesOfExecution.get(close.key) ?? []) owners.add(id);
    orderCloses.set(key, owners);
  }
  for (const key of [...orderCloses.keys()].sort()) {
    const openDraftId = orderOpenings.get(key);
    const closeDraftIds = orderCloses.get(key);
    if (openDraftId === undefined || closeDraftIds === undefined) continue;
    const sources = ledger.executions
      .filter((execution) => groupKeyOf(execution) === key)
      .flatMap((execution) => execution.sources);
    for (const closeDraftId of [...closeDraftIds].sort())
      addLink(closeDraftId, openDraftId, "roll", sources);
  }
  // Matching an opening establishes quantity provenance, not the event type.
  // Run after link validation so broker evidence and retained corrections can
  // resolve booked events, including corrections within a single strategy.
  for (const draft of drafts.values()) {
    for (const leg of draft.legs) {
      const execution = context.executionByKey.get(leg.executionKey);
      if (
        !execution ||
        leg.role !== "close" ||
        !looksLikeBookedEvent(execution) ||
        resolvedEvents.has(execution.key)
      )
        continue;
      draft.unresolved = true;
      draft.complete = false;
      pushDraftIssue(
        draft,
        makeIssue(
          "LIFECYCLE_UNRESOLVED",
          execution.sources,
          "warning",
          execution.key,
        ),
      );
    }
  }
  return links;
}

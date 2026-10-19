import type { SourceRef } from "../../shared/domain.js";
import {
  type Binding,
  type LifecycleInstruction,
  type MergeInstruction,
  sourceKey,
} from "./grouping-common.js";
import type { GroupingContext } from "./grouping-context.js";
import { makeIssue } from "./projection.js";

export interface RetainedInstructions {
  bindings: Binding[];
  merges: MergeInstruction[];
  lifecycles: LifecycleInstruction[];
}

export function readRetainedDecisions(
  context: GroupingContext,
): RetainedInstructions {
  const { orderedDecisions, executionByKey, executionBySource, addIssue } =
    context;
  const bindings: Binding[] = [];
  const merges: MergeInstruction[] = [];
  const lifecycles: LifecycleInstruction[] = [];
  for (const decision of orderedDecisions) {
    const payload = decision.payload;
    switch (decision.kind) {
      case "manual_allocation": {
        const strategyId =
          typeof payload.strategyId === "string"
            ? payload.strategyId
            : undefined;
        if (strategyId === undefined) continue;
        const source = payload.source as SourceRef | undefined;
        const entries = Array.isArray(payload.allocations)
          ? (payload.allocations as Array<Record<string, unknown>>)
          : [];
        for (const entry of entries) {
          const executionKey =
            typeof entry.executionKey === "string"
              ? entry.executionKey
              : undefined;
          const execution =
            (executionKey !== undefined
              ? executionByKey.get(executionKey)
              : undefined) ??
            (source !== undefined
              ? executionBySource.get(sourceKey(source))
              : undefined);
          if (execution === undefined) continue;
          bindings.push({
            strategyId,
            execution,
            quantity:
              typeof entry.quantity === "string"
                ? entry.quantity
                : execution.quantity,
            netCash:
              typeof entry.netCash === "string"
                ? entry.netCash
                : execution.netCash,
            brokerPnl:
              entry.brokerPnl === null
                ? null
                : typeof entry.brokerPnl === "string"
                  ? entry.brokerPnl
                  : execution.brokerPnl,
          });
        }
        break;
      }
      case "group_explicit": {
        const strategyId =
          typeof payload.strategyId === "string"
            ? payload.strategyId
            : undefined;
        const source = payload.source as SourceRef | undefined;
        if (strategyId === undefined || source === undefined) continue;
        const execution = executionBySource.get(sourceKey(source));
        if (execution === undefined) continue;
        bindings.push({
          strategyId,
          execution,
          quantity: null,
          netCash: null,
          brokerPnl: null,
        });
        break;
      }
      case "group_merge": {
        const chosen =
          typeof payload.chosenStrategyId === "string"
            ? payload.chosenStrategyId
            : undefined;
        const merged = Array.isArray(payload.mergedStrategyIds)
          ? payload.mergedStrategyIds.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        if (chosen !== undefined && merged.length > 0) {
          merges.push({ chosen, merged });
        }
        break;
      }
      case "group_split": {
        // A retained split is never applied to the projection yet: the payload
        // carries parent/child identities but no parent-to-child allocation
        // mapping, so a deterministic split is impossible. Surface it as a
        // review item rather than silently ignoring the decision.
        const parent =
          typeof payload.parentStrategyId === "string"
            ? payload.parentStrategyId
            : undefined;
        if (parent === undefined) continue;
        addIssue(makeIssue("SPLIT_NOT_APPLIED", [], "warning", parent));
        break;
      }
      case "lifecycle": {
        const event =
          typeof payload.event === "string" ? payload.event : undefined;
        const sourceRef = payload.sourceRef as SourceRef | undefined;
        const targetRef = payload.targetRef as SourceRef | undefined;
        if (
          event !== undefined &&
          sourceRef !== undefined &&
          targetRef !== undefined
        ) {
          lifecycles.push({
            event,
            source: sourceRef,
            target: targetRef,
            sources: decision.sources,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return { bindings, merges, lifecycles };
}

import type { Execution, Id, SourceRef } from "../../shared/domain.js";
import { isClosingEvent, looksLikeBookedEvent } from "./lifecycle.js";

export type ResolveId = (account: string, keys: string[]) => Id;

export interface Link {
  from: Id;
  to: Id;
  type: string;
  sources: SourceRef[];
}

export interface MergeInstruction {
  chosen: Id;
  merged: Id[];
}

export interface LifecycleInstruction {
  event: string;
  source: SourceRef;
  target: SourceRef;
  sources: SourceRef[];
}

export function sourceKey(source: SourceRef): string {
  return `${source.importId}:${source.rowNumber}`;
}

export function roleOf(execution: Execution): "open" | "close" {
  if (execution.event === "unsupported") return "close";
  if (execution.action === "open") return "open";
  if (execution.action === "close") return "close";
  if (execution.action === "mixed") return "close";
  if (isClosingEvent(execution.event)) return "close";
  if (looksLikeBookedEvent(execution)) return "close";
  return "open";
}

function orderKeyOf(execution: Execution): string {
  return (
    execution.brokerIds.BrokerageOrderID ??
    execution.brokerIds.IBOrderID ??
    `exec:${execution.key}`
  );
}

export function groupKeyOf(execution: Execution): string {
  return `${execution.account}\u0000${execution.currency}\u0000${orderKeyOf(execution)}`;
}

export function sortedByKey(executions: readonly Execution[]): Execution[] {
  return [...executions].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );
}

export interface Binding {
  strategyId: Id;
  execution: Execution;
  /** Null quantity means bind the execution's whole remaining units. */
  quantity: string | null;
  netCash: string | null;
  brokerPnl: string | null;
}

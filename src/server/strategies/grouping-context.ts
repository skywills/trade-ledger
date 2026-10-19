import { Decimal } from "decimal.js";
import type {
  Decision,
  Execution,
  Id,
  Issue,
  LedgerSnapshot,
  SourceRef,
} from "../../shared/domain.js";
import { type ResolveId, sourceKey } from "./grouping-common.js";
import {
  emptyDraft,
  makeIssue,
  pushDraftIssue,
  type StrategyDraft,
} from "./projection.js";

interface Consumption {
  quantity: Decimal;
  netCash: Decimal;
  brokerPnl: Decimal;
}

/**
 * Per-projection state. This context owns indexes, issue insertion, draft
 * creation, and consumption; phases populate the drafts they retrieve.
 */
export interface GroupingContext {
  ledger: LedgerSnapshot;
  orderedDecisions: readonly Decision[];
  resolveId: ResolveId;
  executionByKey: ReadonlyMap<Id, Execution>;
  executionBySource: ReadonlyMap<string, Execution>;
  issues: ReadonlyMap<string, Issue>;
  drafts: ReadonlyMap<Id, StrategyDraft>;
  addIssue(issue: Issue): void;
  draftFor(
    id: Id,
    account: string,
    currency: string,
    sources?: SourceRef[],
  ): StrategyDraft;
  availableOf(execution: Execution): Decimal;
  residualNetCash(execution: Execution): string;
  residualBrokerPnl(execution: Execution): string | null;
  recordConsumption(
    execution: Execution,
    quantity: string,
    netCash: string,
    brokerPnl: string | null,
  ): void;
}

export function createGroupingContext(
  ledger: LedgerSnapshot,
  decisions: readonly Decision[],
  resolveId: ResolveId,
): GroupingContext {
  const orderedDecisions = [...decisions].sort((left, right) =>
    left.sequence !== right.sequence
      ? left.sequence - right.sequence
      : left.id < right.id
        ? -1
        : 1,
  );

  const executionByKey = new Map<Id, Execution>();
  const executionBySource = new Map<string, Execution>();
  for (const execution of ledger.executions) {
    executionByKey.set(execution.key, execution);
    for (const source of execution.sources) {
      executionBySource.set(sourceKey(source), execution);
    }
  }

  const issues = new Map<string, Issue>();
  const addIssue = (issue: Issue): void => {
    if (!issues.has(issue.key)) issues.set(issue.key, issue);
  };

  const drafts = new Map<Id, StrategyDraft>();
  const draftFor = (
    id: Id,
    account: string,
    currency: string,
    sources: SourceRef[] = [],
  ): StrategyDraft => {
    const existing = drafts.get(id);
    if (existing !== undefined) {
      if (existing.account !== account || existing.currency !== currency) {
        const splitId = `${id}\u0000incompatible\u0000${account}\u0000${currency}`;
        const split = drafts.get(splitId);
        if (split !== undefined) return split;
        const incompatible = emptyDraft(splitId);
        incompatible.account = account;
        incompatible.currency = currency;
        incompatible.unresolved = true;
        incompatible.blocking = true;
        incompatible.complete = false;
        const issue = makeIssue(
          "INCOMPATIBLE_STRATEGY_MEMBERSHIP",
          sources,
          "error",
          `${id}:${account}:${currency}`,
        );
        pushDraftIssue(incompatible, issue);
        addIssue(issue);
        drafts.set(splitId, incompatible);
        return incompatible;
      }
      if (existing.account === "") existing.account = account;
      if (existing.currency === "") existing.currency = currency;
      return existing;
    }
    const draft = emptyDraft(id);
    draft.account = account;
    draft.currency = currency;
    drafts.set(id, draft);
    return draft;
  };

  const consumed = new Map<Id, Consumption>();
  const consumptionOf = (key: Id): Consumption =>
    consumed.get(key) ?? {
      quantity: new Decimal(0),
      netCash: new Decimal(0),
      brokerPnl: new Decimal(0),
    };
  const recordConsumption = (
    execution: Execution,
    quantity: string,
    netCash: string,
    brokerPnl: string | null,
  ): void => {
    const current = consumptionOf(execution.key);
    consumed.set(execution.key, {
      quantity: current.quantity.plus(quantity),
      netCash: current.netCash.plus(netCash),
      brokerPnl: current.brokerPnl.plus(brokerPnl ?? 0),
    });
  };
  /** Signed units of an execution still available for automatic matching. */
  const availableOf = (execution: Execution): Decimal => {
    const total = new Decimal(execution.quantity);
    const residual = total.minus(consumptionOf(execution.key).quantity);
    if (total.isZero() || residual.isZero()) return new Decimal(0);
    if (residual.isNegative() !== total.isNegative()) return new Decimal(0);
    return residual;
  };
  const residualNetCash = (execution: Execution): string =>
    new Decimal(execution.netCash)
      .minus(consumptionOf(execution.key).netCash)
      .toFixed();
  const residualBrokerPnl = (execution: Execution): string | null => {
    if (execution.brokerPnl === null) return null;
    return new Decimal(execution.brokerPnl)
      .minus(consumptionOf(execution.key).brokerPnl)
      .toFixed();
  };
  return {
    ledger,
    orderedDecisions,
    resolveId,
    executionByKey,
    executionBySource,
    issues,
    drafts,
    addIssue,
    draftFor,
    availableOf,
    residualNetCash,
    residualBrokerPnl,
    recordConsumption,
  };
}

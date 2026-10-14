import type { Id, Issue, SourceRef } from "../../shared/domain.js";
import { compareSources, type ResolvedTransaction } from "./identity.js";

export type RevisionState = "active" | "superseded" | "cancelled";

export interface RevisionDraft {
  logicalKey: string;
  revisionNumber: number;
  state: RevisionState;
  /**
   * The merged active payload of this revision. For a cancellation evidence
   * row the payload is retained as reproducible evidence but its state keeps
   * the logical transaction out of active executions.
   */
  payload: ResolvedTransaction["merged"];
  importRowIds: Id[];
}

export interface RevisionOutcome {
  /** Every retained revision of every logical transaction, heads included. */
  revisions: RevisionDraft[];
  issues: Issue[];
}

function firstSource(transaction: ResolvedTransaction) {
  return transaction.merged.sources[0] ?? { importId: "", rowNumber: 0 };
}

function isCancellationEvidence(transaction: ResolvedTransaction): boolean {
  return (
    transaction.merged.quantity === "0" && transaction.merged.netCash === "0"
  );
}

/**
 * Applies explicit broker revision evidence to logical transactions. A row
 * referencing an original through OrigTradeID is a correction (active payload
 * replaces the referenced revision) or, when its signed quantity and net cash
 * are both zero, a cancellation. Changed payloads without such explicit
 * evidence never reach this path: identity resolution already holds them as
 * conflicts. References are resolved within the account scope; evidence is
 * applied in deterministic raw-source order, never upload time.
 */
export function applyRevisions(
  transactions: readonly ResolvedTransaction[],
): RevisionOutcome {
  const ordered = [...transactions].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
  );

  const chains = new Map<string, RevisionDraft[]>();
  const tradeIndex = new Map<string, string>();
  const issues: Issue[] = [];

  const standalone = ordered.filter(
    (transaction) =>
      !transaction.conflicted && transaction.referencesTradeId === null,
  );
  for (const transaction of standalone) {
    chains.set(transaction.key, [
      {
        logicalKey: transaction.key,
        revisionNumber: 1,
        state: "active",
        payload: transaction.merged,
        importRowIds: transaction.importRowIds,
      },
    ]);
    if (transaction.tradeId !== null) {
      tradeIndex.set(
        `${transaction.account}\u0000${transaction.tradeId}`,
        transaction.key,
      );
    }
  }

  let pending = ordered
    .filter(
      (transaction) =>
        !transaction.conflicted && transaction.referencesTradeId !== null,
    )
    .sort((left, right) =>
      compareSources(firstSource(left), firstSource(right)),
    );

  const registerUnresolved = (transaction: ResolvedTransaction): void => {
    issues.push({
      key: `ledger:unresolved_revision_reference:${transaction.key}`,
      code: "unresolved_revision_reference",
      sources: transaction.merged.sources,
      severity: "error",
    });
  };

  // Resolve only rows whose predecessor is already in a known chain. Repeating
  // this pass handles arbitrary source ordering and multiple correction hops;
  // rows left when no progress is possible are missing references or cycles.
  while (pending.length > 0) {
    let progressed = false;
    const unresolved: ResolvedTransaction[] = [];
    const readyByTarget = new Map<string, ResolvedTransaction[]>();
    const readyTransactions = new Set<string>();
    for (const transaction of pending) {
      const reference = transaction.referencesTradeId;
      if (reference === null) continue;
      const targetKey = tradeIndex.get(
        `${transaction.account}\u0000${reference}`,
      );
      if (targetKey === undefined || targetKey === transaction.key) continue;
      readyTransactions.add(transaction.key);
      const candidates = readyByTarget.get(targetKey) ?? [];
      candidates.push(transaction);
      readyByTarget.set(targetKey, candidates);
    }
    const ambiguousTransactions = new Set<string>();
    for (const [targetKey, candidates] of readyByTarget) {
      if (candidates.length < 2) continue;
      const chain = chains.get(targetKey) ?? [];
      const sourceMap = new Map<string, SourceRef>();
      for (const source of [
        ...chain.flatMap((revision) => revision.payload.sources),
        ...candidates.flatMap((candidate) => candidate.merged.sources),
      ]) {
        sourceMap.set(`${source.importId}\u0000${source.rowNumber}`, source);
      }
      const sources = [...sourceMap.values()].sort(compareSources);
      issues.push({
        key: `ledger:ambiguous_revision_reference:${targetKey}`,
        code: "ambiguous_revision_reference",
        sources,
        severity: "error",
      });
      chains.delete(targetKey);
      for (const [tradeKey, chainKey] of tradeIndex) {
        if (chainKey === targetKey) tradeIndex.delete(tradeKey);
      }
      for (const candidate of candidates) {
        ambiguousTransactions.add(candidate.key);
      }
      progressed = true;
    }

    for (const transaction of pending) {
      if (ambiguousTransactions.has(transaction.key)) continue;
      if (!readyTransactions.has(transaction.key)) {
        unresolved.push(transaction);
        continue;
      }
      const reference = transaction.referencesTradeId;
      if (reference === null) continue;
      const targetKey = tradeIndex.get(
        `${transaction.account}\u0000${reference}`,
      );
      const targetChain =
        targetKey === undefined ? undefined : chains.get(targetKey);
      const previous = targetChain?.[targetChain.length - 1];
      if (
        targetKey === undefined ||
        targetKey === transaction.key ||
        targetChain === undefined ||
        previous === undefined
      ) {
        unresolved.push(transaction);
        continue;
      }

      const cancellation = isCancellationEvidence(transaction);
      previous.state = cancellation ? "cancelled" : "superseded";
      targetChain.push({
        logicalKey: targetKey,
        revisionNumber: previous.revisionNumber + 1,
        state: cancellation ? "cancelled" : "active",
        payload: transaction.merged,
        importRowIds: transaction.importRowIds,
      });
      if (transaction.tradeId !== null) {
        tradeIndex.set(
          `${transaction.account}\u0000${transaction.tradeId}`,
          targetKey,
        );
      }
      progressed = true;
    }
    if (!progressed) {
      for (const transaction of unresolved) registerUnresolved(transaction);
      break;
    }
    pending = unresolved;
  }

  const revisions: RevisionDraft[] = [];
  for (const key of [...chains.keys()].sort()) {
    const chain = chains.get(key);
    if (chain === undefined) continue;
    revisions.push(...chain);
  }
  return { revisions, issues };
}

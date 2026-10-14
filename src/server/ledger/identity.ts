import type { Execution, Id, Issue, SourceRef } from "../../shared/domain.js";

export interface Candidate {
  source: SourceRef;
  importRowId: Id;
  execution: Execution;
}

/**
 * A retained, account-scoped resolution of a weak row (one with no strong
 * broker identity) to a canonical identity. Rows bound to the same canonical
 * identity and account merge into one logical transaction; the binding is the
 * only thing that may collapse weak rows.
 */
export interface IdentityBinding {
  source: SourceRef;
  canonicalIdentity: string;
  expectedQuantity: string;
  decisionId: Id;
}

/**
 * A resolved logical transaction: every candidate row that unambiguously
 * belongs to one account-scoped broker identity, merged into a single
 * financial payload with every contributing source retained.
 */
export interface ResolvedTransaction {
  key: string;
  account: string;
  tradeId: string | null;
  /** OrigTradeID carried by the rows when the broker explicitly references an original. */
  referencesTradeId: string | null;
  merged: Execution;
  importRowIds: Id[];
  conflicted: boolean;
}

export interface IdentityResult {
  transactions: ResolvedTransaction[];
  issues: Issue[];
}

/**
 * Deterministic raw-source order. Import ids and row numbers are stable
 * retained identifiers, so ordering never depends on upload time.
 */
export function compareSources(left: SourceRef, right: SourceRef): number {
  if (left.importId !== right.importId) {
    return left.importId < right.importId ? -1 : 1;
  }
  return left.rowNumber - right.rowNumber;
}

function tradeKey(account: string, tradeId: string): string {
  return `txn:${account}:trade:${tradeId}`;
}

function execKey(account: string, execId: string): string {
  return `txn:${account}:exec:${execId}`;
}

function sourceKey(source: SourceRef): string {
  return `txn:${source.importId}:src:${source.rowNumber}`;
}

function refKey(source: SourceRef): string {
  return `${source.importId}\u0000${source.rowNumber}`;
}

function bindingKey(account: string, canonicalIdentity: string): string {
  return `txn:${account}:binding:${canonicalIdentity}`;
}

/**
 * Maps each retained binding's source row to its canonical identity. Two
 * bindings for one source that disagree on the canonical identity are
 * contradictory: that source is left on its source-based identity rather than
 * silently joining either target. Every contested source is also returned so
 * the contradiction surfaces as a review issue instead of vanishing.
 */
function bindingTargets(bindings: readonly IdentityBinding[]): {
  targets: Map<string, string>;
  conflicts: SourceRef[];
} {
  const bySource = new Map<string, string>();
  const conflicted = new Map<string, SourceRef>();
  for (const binding of bindings) {
    const key = refKey(binding.source);
    const existing = bySource.get(key);
    if (existing === undefined) {
      bySource.set(key, binding.canonicalIdentity);
    } else if (existing !== binding.canonicalIdentity) {
      conflicted.set(key, binding.source);
    }
  }
  for (const key of conflicted.keys()) bySource.delete(key);
  return { targets: bySource, conflicts: [...conflicted.values()] };
}

/**
 * Financial fingerprint over canonical normalized values. Broker identifiers
 * are excluded because re-exports may carry partial identifier sets (for
 * example an execution id without a trade id); instrument objects serialize
 * in a fixed field order because normalizeExecution constructs them.
 */
function payloadFingerprint(execution: Execution): string {
  return JSON.stringify([
    execution.date,
    execution.rawDateTime,
    execution.quantity,
    execution.price,
    execution.currency,
    execution.netCash,
    execution.proceeds,
    execution.commission,
    execution.taxes,
    execution.basis,
    execution.brokerPnl,
    execution.action,
    execution.event,
    execution.instrument,
    execution.codes,
    execution.timezone,
  ]);
}

function brokerIdConflict(
  merged: Record<string, string>,
  candidate: Record<string, string>,
): boolean {
  for (const [name, value] of Object.entries(candidate)) {
    const existing = merged[name];
    if (existing !== undefined && existing !== value) return true;
  }
  return false;
}

interface Group {
  account: string;
  tradeId: string | null;
  items: Candidate[];
}

function emptyIssueKey(code: string, scope: string): string {
  return `ledger:${code}:${scope}`;
}

/**
 * Resolves candidate execution rows into account-scoped logical
 * transactions. Matching precedence: account + TradeID first, then a
 * nonconflicting IBExecID alias registered by rows that carry both
 * identifiers, then the retained source reference for weak rows. Rows whose
 * payloads disagree on one strong identity are conflicted: they never merge,
 * never silently replace an active revision, and surface as review issues.
 */
export function resolveIdentities(
  candidates: readonly Candidate[],
  bindings: readonly IdentityBinding[] = [],
): IdentityResult {
  const ordered = [...candidates].sort((left, right) =>
    compareSources(left.source, right.source),
  );
  const { targets: boundTargets, conflicts: bindingConflicts } =
    bindingTargets(bindings);

  const aliasToTrade = new Map<string, string>();
  const aliasCandidates = new Map<string, Candidate[]>();
  const conflictedAliases = new Map<string, Candidate[]>();
  const blockedSources = new Set<string>();
  const conflictIssues: Issue[] = [];
  const candidateSourceKey = (candidate: Candidate): string =>
    `${candidate.source.importId}\u0000${candidate.source.rowNumber}`;
  for (const candidate of ordered) {
    const execId = candidate.execution.brokerIds.IBExecID;
    if (execId === undefined) continue;
    const aliasKey = `${candidate.execution.account}\u0000${execId}`;
    const candidatesForAlias = aliasCandidates.get(aliasKey) ?? [];
    candidatesForAlias.push(candidate);
    aliasCandidates.set(aliasKey, candidatesForAlias);
  }
  for (const [aliasKey, aliasRows] of aliasCandidates) {
    const tradeIds = new Set(
      aliasRows
        .map((candidate) => candidate.execution.brokerIds.TradeID)
        .filter((tradeId): tradeId is string => tradeId !== undefined),
    );
    if (tradeIds.size <= 1) {
      const onlyTradeId = [...tradeIds][0];
      if (onlyTradeId !== undefined) aliasToTrade.set(aliasKey, onlyTradeId);
      continue;
    }

    // Explicit OrigTradeID lineage can disambiguate a broker-reused execution
    // ID. In that case strong-ID corrections remain usable, while an
    // execution-only occurrence still needs a retained identity decision.
    const lineage = new Map<string, Set<string>>();
    for (const candidate of aliasRows) {
      const tradeId = candidate.execution.brokerIds.TradeID;
      const originalTradeId = candidate.execution.brokerIds.OrigTradeID;
      if (tradeId === undefined || originalTradeId === undefined) continue;
      const from = lineage.get(tradeId) ?? new Set<string>();
      from.add(originalTradeId);
      lineage.set(tradeId, from);
      const to = lineage.get(originalTradeId) ?? new Set<string>();
      to.add(tradeId);
      lineage.set(originalTradeId, to);
    }
    const reached = new Set<string>();
    const queue = [[...tradeIds][0]];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined || reached.has(current)) continue;
      reached.add(current);
      for (const related of lineage.get(current) ?? []) queue.push(related);
    }
    const explicitlyResolved = [...tradeIds].every((tradeId) =>
      reached.has(tradeId),
    );
    const unresolvedRows = aliasRows.filter(
      (candidate) =>
        !(
          candidate.execution.brokerIds.TradeID === undefined &&
          boundTargets.has(candidateSourceKey(candidate))
        ) &&
        (!explicitlyResolved ||
          candidate.execution.brokerIds.TradeID === undefined),
    );
    if (unresolvedRows.length === 0) continue;

    conflictedAliases.set(aliasKey, aliasRows);
    for (const candidate of unresolvedRows) {
      blockedSources.add(candidateSourceKey(candidate));
    }
    conflictIssues.push({
      key: emptyIssueKey("alias_conflict", aliasKey),
      code: "alias_conflict",
      sources: unresolvedRows.map((candidate) => candidate.source),
      severity: "error",
    });
  }

  const groups = new Map<string, Group>();
  const groupOrder: string[] = [];
  for (const candidate of ordered) {
    const { account, brokerIds } = candidate.execution;
    if (blockedSources.has(candidateSourceKey(candidate))) continue;
    const tradeId = brokerIds.TradeID;
    const execId = brokerIds.IBExecID;
    let key: string;
    let resolvedTradeId: string | null = null;
    if (tradeId !== undefined) {
      key = tradeKey(account, tradeId);
      resolvedTradeId = tradeId;
    } else if (
      execId !== undefined &&
      conflictedAliases.has(`${account}\u0000${execId}`)
    ) {
      const bound = boundTargets.get(candidateSourceKey(candidate));
      if (bound === undefined) continue;
      key = bindingKey(account, bound);
    } else if (execId !== undefined) {
      const aliasTarget = aliasToTrade.get(`${account}\u0000${execId}`);
      if (aliasTarget !== undefined) {
        key = tradeKey(account, aliasTarget);
        resolvedTradeId = aliasTarget;
      } else {
        const bound = boundTargets.get(refKey(candidate.source));
        key =
          bound !== undefined
            ? bindingKey(account, bound)
            : execKey(account, execId);
      }
    } else {
      const bound = boundTargets.get(refKey(candidate.source));
      key =
        bound !== undefined
          ? bindingKey(account, bound)
          : sourceKey(candidate.source);
    }

    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        account,
        tradeId: resolvedTradeId,
        items: [candidate],
      });
      groupOrder.push(key);
    } else {
      group.items.push(candidate);
    }
  }

  const issues: Issue[] = [];
  for (const source of bindingConflicts) {
    issues.push({
      key: emptyIssueKey(
        "binding_conflict",
        `${source.importId}:${source.rowNumber}`,
      ),
      code: "binding_conflict",
      sources: [source],
      severity: "warning",
    });
  }
  issues.push(...conflictIssues);

  const transactions: ResolvedTransaction[] = [];
  for (const key of groupOrder) {
    const group = groups.get(key);
    if (group === undefined) continue;
    const [first] = group.items;
    if (first === undefined) continue;

    const fingerprints = new Set(
      group.items.map((item) => payloadFingerprint(item.execution)),
    );
    const mergedBrokerIds: Record<string, string> = {};
    let idConflict = false;
    for (const item of group.items) {
      if (brokerIdConflict(mergedBrokerIds, item.execution.brokerIds)) {
        idConflict = true;
        break;
      }
      for (const [name, value] of Object.entries(item.execution.brokerIds)) {
        if (mergedBrokerIds[name] === undefined) mergedBrokerIds[name] = value;
      }
    }

    const conflicted = fingerprints.size > 1 || idConflict;
    if (conflicted) {
      issues.push({
        key: emptyIssueKey("identity_conflict", key),
        code: "identity_conflict",
        sources: group.items.map((item) => item.source),
        severity: "error",
      });
      continue;
    }

    transactions.push({
      key,
      account: group.account,
      tradeId: group.tradeId,
      referencesTradeId: first.execution.brokerIds.OrigTradeID ?? null,
      merged: { ...first.execution, brokerIds: mergedBrokerIds },
      importRowIds: group.items.map((item) => item.importRowId),
      conflicted: false,
    });
  }

  return { transactions, issues };
}

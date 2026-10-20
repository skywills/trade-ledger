import { Decimal } from "decimal.js";
import type {
  AttachmentSuggestion,
  Lifecycle,
  LifecycleMember,
} from "../../shared/lifecycles.js";
import type { Execution } from "../api.js";

export interface ConnectionGroup {
  key: string;
  canReviewWhole: boolean;
  underlying: string;
  currency: string;
  instrument: Execution["instrument"];
  suggestions: AttachmentSuggestion[];
  members: LifecycleMember[];
  candidateIds: string[];
  affectedIds: string[];
  contracts: string;
  shares: string | null;
}

export function connectionGroups(
  suggestions: AttachmentSuggestion[],
  members: LifecycleMember[],
  executions: Execution[],
): ConnectionGroup[] {
  const exec = new Map(executions.map((e) => [e.key, e]));
  const groups = new Map<string, AttachmentSuggestion[]>();
  for (const suggestion of suggestions) {
    const e = exec.get(suggestion.callOpening.executionKey);
    if (!e) continue;
    const key = JSON.stringify([
      suggestion.callOpening.strategyId,
      e.instrument.key,
    ]);
    const group = groups.get(key) ?? [];
    group.push(suggestion);
    groups.set(key, group);
  }
  return [...groups].flatMap(([key, suggestions]): ConnectionGroup[] => {
    const first = suggestions[0];
    const e = first && exec.get(first.callOpening.executionKey);
    if (!first || !e) return [];
    const rows = members.filter(
      (m) =>
        m.allocation.strategyId === first.callOpening.strategyId &&
        exec.get(m.allocation.executionKey)?.instrument.key ===
          e.instrument.key,
    );
    const contracts = rows
      .filter((m) => m.allocation.role === "open")
      .reduce((sum, m) => sum.plus(m.quantity), new Decimal(0))
      .abs();
    const candidateIds = first.candidateLifecycleIds.filter((id) =>
      suggestions.every((s) => s.candidateLifecycleIds.includes(id)),
    );
    return [
      {
        key,
        canReviewWhole: rows
          .filter((m) => m.allocation.role === "open")
          .every((m) =>
            suggestions.some(
              (s) => s.callOpening.executionKey === m.allocation.executionKey,
            ),
          ),
        instrument: e.instrument,
        underlying: e.instrument.underlying ?? e.instrument.symbol,
        currency: e.currency,
        suggestions,
        members: rows,
        candidateIds,
        affectedIds: [
          ...new Set([
            ...rows.map((m) => m.lifecycleId),
            ...suggestions.flatMap((s) => s.candidateLifecycleIds),
          ]),
        ],
        contracts: contracts.toString(),
        shares: e.instrument.multiplier
          ? contracts.times(e.instrument.multiplier).toString()
          : null,
      },
    ];
  });
}

/** Complete current source partitions; nothing infers ownership of individual closes. */
export function connectionProposal(
  group: ConnectionGroup,
  targetId: string,
  separate = false,
) {
  const assignments = new Map<
    string,
    {
      allocation: LifecycleMember["allocation"];
      lifecycleId: string;
      quantity: string;
    }
  >();
  for (const member of group.members) {
    const lifecycleId = separate ? member.lifecycleId : targetId;
    const key = JSON.stringify([
      member.allocation.strategyId,
      member.allocation.executionKey,
      member.allocation.role,
      lifecycleId,
    ]);
    const previous = assignments.get(key);
    assignments.set(key, {
      allocation: member.allocation,
      lifecycleId,
      quantity: new Decimal(previous?.quantity ?? 0)
        .plus(member.quantity)
        .toString(),
    });
  }
  return {
    kind: "lifecycle_membership" as const,
    rationale: separate
      ? "Keep these call trades independent of the share lifecycle."
      : "Connect the listed call fills and closes to the selected share lifecycle.",
    payload: {
      requireCallCoverage: !separate,
      assignments: [...assignments.values()],
    },
  };
}

export function lifecycleLabel(lifecycle: Lifecycle | undefined): string {
  if (!lifecycle) return "Trade lifecycle";
  return `${lifecycle.description || lifecycle.underlyingKey.replace(/^value:/, "")} · opened ${lifecycle.openingDate ?? "date unknown"}`;
}

export function reviewLabel(reasons: string[]): string {
  return reasons
    .map((reason) =>
      reason === "PENDING_CALL_ATTACHMENT"
        ? "Confirm whether these calls belong to your shares"
        : reason.replaceAll("_", " ").toLowerCase(),
    )
    .join(" · ");
}

export function tradeActionLabel(
  execution: Execution | undefined,
  quantity: string,
  role: "open" | "close",
): string {
  if (!execution) return "Source trade";
  const positive = new Decimal(quantity).gt(0);
  if (execution.instrument.assetClass === "STK") {
    const action = positive ? "Acquired shares" : "Sold shares";
    return execution.event === "assignment"
      ? `${action} through assignment`
      : action;
  }
  const options = execution.instrument.putCall === "P" ? "puts" : "calls";
  if (execution.event === "assignment")
    return `${execution.instrument.putCall === "P" ? "Puts" : "Calls"} assigned`;
  if (execution.event === "exercise") return "Options exercised";
  if (execution.event === "expiry") return "Options expired";
  return role === "open"
    ? `${positive ? "Bought" : "Sold"} ${options}`
    : `${positive ? "Bought back" : "Closed"} ${options}`;
}

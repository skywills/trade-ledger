import { Decimal } from "decimal.js";
import type { Decision, LedgerSnapshot } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import {
  LifecycleAttachmentPayloadSchema,
  LifecycleMembershipPayloadSchema,
  type LifecycleProjection,
} from "../../shared/lifecycles.js";
import { compareLifecycleTime } from "./chronology.js";
import { refKey } from "./membership.js";

export class ConnectionDependencyError extends AppError {
  constructor(
    readonly blockingConnection: { date: string; lifecycleId: string },
  ) {
    super(
      "EARLIER_CONNECTION_UNRESOLVED",
      `Resolve the earlier connection dated ${blockingConnection.date} first.`,
      409,
    );
  }
}

/** Only covered connections depend on earlier reviews; keeping calls separate is always available. */
export function coveredConnectionAssignments(candidate: Decision) {
  if (candidate.kind === "lifecycle_attachment") {
    const p = LifecycleAttachmentPayloadSchema.parse(candidate.payload);
    return p.targets.map((t) => ({ ...t, allocation: p.opening }));
  }
  if (candidate.kind === "lifecycle_membership") {
    const p = LifecycleMembershipPayloadSchema.parse(candidate.payload);
    return p.requireCallCoverage ? p.assignments : [];
  }
  return [];
}

export function assertConnectionOrder(
  ledger: LedgerSnapshot,
  current: LifecycleProjection,
  assignments: ReturnType<typeof coveredConnectionAssignments>,
): void {
  const executions = new Map(ledger.executions.map((e) => [e.key, e]));
  const openings = assignments.flatMap((a) => {
    const e = executions.get(a.allocation.executionKey);
    return a.allocation.role === "open" &&
      e?.instrument.putCall === "C" &&
      new Decimal(a.quantity).lt(0)
      ? [{ execution: e, lifecycleId: a.lifecycleId }]
      : [];
  });
  const included = new Set(openings.map((a) => a.execution.key));
  const pending = current.suggestions.flatMap((s) => {
    const e = executions.get(s.callOpening.executionKey);
    if (!e || included.has(e.key)) return [];
    const target = openings.find(
      (a) =>
        s.candidateLifecycleIds.includes(a.lifecycleId) &&
        compareLifecycleTime(e, a.execution) === -1,
    );
    return target
      ? [{ suggestion: s, execution: e, targetId: target.lifecycleId }]
      : [];
  });
  pending.sort(
    (a, b) =>
      a.execution.date.localeCompare(b.execution.date) ||
      (compareLifecycleTime(a.execution, b.execution) ?? 0),
  );
  const earlier = pending[0];
  if (!earlier) return;
  const owner = current.members.find(
    (m) => refKey(m.allocation) === refKey(earlier.suggestion.callOpening),
  );
  throw new ConnectionDependencyError({
    date: earlier.execution.date,
    lifecycleId: owner?.lifecycleId ?? earlier.targetId,
  });
}

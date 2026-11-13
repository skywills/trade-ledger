import { Decimal } from "decimal.js";
import type {
  Decision,
  Execution,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type {
  AllocationRef,
  AttachmentSuggestion,
  ConnectionPlan,
  LifecycleMember,
  LifecycleProjection,
  RetainedLifecycleAnchor,
} from "../../shared/lifecycles.js";
import { compareLifecycleTime } from "./chronology.js";
import {
  compareByTime,
  isRollRelease,
  sharesSoldAfter,
  spreadLeg,
} from "./connection-plan-reasons.js";
import { refKey } from "./membership.js";
import { validateLifecycleDecision } from "./validate-decision.js";

export interface PlanInput {
  ledger: LedgerSnapshot;
  projection: Projection;
  decisions: readonly Decision[];
  lifecycles: LifecycleProjection;
  origins?: Projection;
  retainedAnchors?: readonly RetainedLifecycleAnchor[];
}

interface PlanRow {
  suggestions: AttachmentSuggestion[];
  members: LifecycleMember[];
  opening: Execution;
}

/** A review row is one call contract within one strategy, as the review screen groups it. */
export function planRowKey(
  s: AttachmentSuggestion,
  exec: Map<string, Execution>,
): string {
  const e = exec.get(s.callOpening.executionKey);
  return JSON.stringify([s.callOpening.strategyId, e?.instrument.key ?? null]);
}

function buildRows(
  lifecycles: LifecycleProjection,
  exec: Map<string, Execution>,
): Map<string, PlanRow[]> {
  const grouped = new Map<string, AttachmentSuggestion[]>();
  for (const s of lifecycles.suggestions) {
    const key = planRowKey(s, exec);
    grouped.set(key, [...(grouped.get(key) ?? []), s]);
  }
  const byPosition = new Map<string, PlanRow[]>();
  for (const suggestions of grouped.values()) {
    const first = suggestions[0];
    const instrumentKey =
      first && exec.get(first.callOpening.executionKey)?.instrument.key;
    if (!first || !instrumentKey) continue;
    const candidates = first.candidateLifecycleIds.filter((id) =>
      suggestions.every((s) => s.candidateLifecycleIds.includes(id)),
    );
    const [target] = candidates;
    if (candidates.length !== 1 || !target) continue;
    const members = lifecycles.members.filter(
      (m) =>
        m.allocation.strategyId === first.callOpening.strategyId &&
        exec.get(m.allocation.executionKey)?.instrument.key === instrumentKey,
    );
    const openings = suggestions.flatMap((s) => {
      const e = exec.get(s.callOpening.executionKey);
      return e ? [e] : [];
    });
    const opening = [...openings].sort(compareOpenings)[0];
    if (!opening) continue;
    byPosition.set(target, [
      ...(byPosition.get(target) ?? []),
      { suggestions, members, opening },
    ]);
  }
  for (const rows of byPosition.values())
    rows.sort((a, b) => compareOpenings(a.opening, b.opening));
  return byPosition;
}

function compareOpenings(a: Execution, b: Execution): number {
  return compareByTime(a, b);
}

/** One assignment per member allocation, quantities summed, as `connectionProposal` builds them. */
function hypotheticalDecision(
  id: string,
  sequence: number,
  requireCallCoverage: boolean,
  rows: PlanRow[],
  lifecycleId: string,
): Decision {
  const assignments = new Map<
    string,
    { allocation: AllocationRef; lifecycleId: string; quantity: string }
  >();
  for (const member of rows.flatMap((r) => r.members)) {
    const key = refKey(member.allocation);
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
    id,
    sequence,
    sources: [],
    strategyIds: [],
    supersedesId: null,
    kind: "lifecycle_membership",
    payload: { requireCallCoverage, assignments: [...assignments.values()] },
  };
}

const REFUSALS = new Set([
  "INVALID_LIFECYCLE_MEMBERSHIP",
  "EARLIER_CONNECTION_UNRESOLVED",
]);

function connects(
  input: PlanInput,
  decisions: Decision[],
  candidate: Decision,
) {
  try {
    validateLifecycleDecision(
      input.ledger,
      input.projection,
      [...input.decisions, ...decisions],
      candidate,
      input.origins,
      input.retainedAnchors,
    );
    return true;
  } catch (error) {
    if (error instanceof AppError && REFUSALS.has(error.code)) return false;
    throw error;
  }
}

function openRef(row: PlanRow): AllocationRef | undefined {
  return row.suggestions
    .map((s) => s.callOpening)
    .find((r) => r.executionKey === row.opening.key);
}

/** The latest close of a row's contract, if any member close is recorded. */
function closeOf(row: PlanRow, exec: Map<string, Execution>): Execution | null {
  const closes = row.members
    .filter((m) => m.allocation.role === "close")
    .flatMap((m) => {
      const e = exec.get(m.allocation.executionKey);
      return e ? [e] : [];
    });
  return closes.sort(compareOpenings).at(-1) ?? null;
}

function closesAtOrBefore(close: Execution | null, opening: Execution) {
  if (!close || close.date !== opening.date) return false;
  const order = compareLifecycleTime(close, opening);
  return order !== null && order <= 0;
}

function closedBefore(close: Execution | null, opening: Execution) {
  if (!close) return false;
  const order = compareLifecycleTime(close, opening);
  return order !== null && order < 0;
}

function connectPlan(
  target: string,
  row: PlanRow,
  accepted: PlanRow[],
  existing: PlanRow[],
  exec: Map<string, Execution>,
): ConnectionPlan {
  const earlier = accepted.filter((a) =>
    closesAtOrBefore(closeOf(a, exec), row.opening),
  );
  const dependsOn = earlier.flatMap((a) => openRef(a) ?? []);
  if (
    isRollRelease(
      row.opening,
      shortCallOpenings([...existing, ...accepted], exec),
    )
  )
    return {
      action: "connect",
      lifecycleId: target,
      reason: "ROLL_RELEASE",
      ...(dependsOn.length ? { dependsOn } : {}),
    };
  return dependsOn.length
    ? {
        action: "connect",
        lifecycleId: target,
        reason: "COVERED_AFTER_EARLIER",
        dependsOn,
      }
    : { action: "connect", lifecycleId: target, reason: "COVERED" };
}

function shortCallOpenings(
  rows: PlanRow[],
  exec: Map<string, Execution>,
): Array<{
  ref: AllocationRef;
  execution: Execution;
  close: Execution | null;
}> {
  return rows.flatMap((r) =>
    r.members
      .filter(
        (m) => m.allocation.role === "open" && new Decimal(m.quantity).lt(0),
      )
      .flatMap((m) => {
        const execution = exec.get(m.allocation.executionKey);
        return execution
          ? [{ ref: m.allocation, execution, close: closeOf(r, exec) }]
          : [];
      }),
  );
}

/** Rows for the short calls already in a position, rebuilt from its members. */
function existingRows(
  target: string,
  lifecycles: LifecycleProjection,
  exec: Map<string, Execution>,
): PlanRow[] {
  const existing = lifecycles.members.filter(
    (m) =>
      m.lifecycleId === target &&
      m.allocation.role === "open" &&
      new Decimal(m.quantity).lt(0) &&
      exec.get(m.allocation.executionKey)?.instrument.putCall === "C",
  );
  return existing.flatMap((m) => {
    const e = exec.get(m.allocation.executionKey);
    if (!e) return [];
    const siblings = lifecycles.members.filter(
      (o) =>
        o.allocation.strategyId === m.allocation.strategyId &&
        exec.get(o.allocation.executionKey)?.instrument.key ===
          e.instrument.key,
    );
    return [{ suggestions: [], members: siblings, opening: e }];
  });
}

function separatePlan(
  target: string,
  row: PlanRow,
  holders: PlanRow[],
  existing: PlanRow[],
  lifecycles: LifecycleProjection,
  exec: Map<string, Execution>,
): ConnectionPlan {
  const held = shortCallOpenings([...existing, ...holders], exec)
    .filter(
      (c) =>
        compareOpenings(c.execution, row.opening) < 0 &&
        !closedBefore(c.close, row.opening),
    )
    .sort((a, b) => compareOpenings(a.execution, b.execution))[0];
  const sharesSold = sharesSoldAfter(
    row.opening,
    held,
    lifecycles.members.filter((m) => m.lifecycleId === target),
    exec,
  );
  return {
    action: "separate",
    lifecycleId: target,
    reason: sharesSold ? "SHARES_SOLD" : "HELD_BY_EARLIER_CALL",
    ...(held ? { heldBy: held.ref } : {}),
    ...(sharesSold ? { sharesSold } : {}),
  };
}

function planPosition(
  input: PlanInput,
  exec: Map<string, Execution>,
  target: string,
  rows: PlanRow[],
): Map<PlanRow, ConnectionPlan> {
  const plans = new Map<PlanRow, ConnectionPlan>();
  const existing = existingRows(target, input.lifecycles, exec);
  const separates: PlanRow[] = [];
  const accepted: PlanRow[] = [];
  rows.forEach((row, n) => {
    const kept = separates.map((s, i) =>
      hypotheticalDecision(
        `plan:sep:${n}:${i}`,
        Number.MAX_SAFE_INTEGER - n - i - 1,
        false,
        [s],
        target,
      ),
    );
    const candidate = hypotheticalDecision(
      "__validate__", // the id decisions treat as a live check: failures throw
      Number.MAX_SAFE_INTEGER,
      true,
      [...accepted, row],
      target,
    );
    const verdict = connects(input, kept, candidate)
      ? connectPlan(target, row, accepted, existing, exec)
      : separatePlan(target, row, accepted, existing, input.lifecycles, exec);
    const pairedWith = spreadLeg(
      row.opening,
      input.ledger.executions,
      input.projection.allocations,
    );
    plans.set(row, pairedWith ? { ...verdict, pairedWith } : verdict);
    if (verdict.action === "connect") accepted.push(row);
    else separates.push(row);
  });
  return plans;
}

/** Recommends, per review row, connecting to or keeping a call apart from its one candidate position. */
export function planConnections(input: PlanInput): LifecycleProjection {
  const exec = new Map(input.ledger.executions.map((e) => [e.key, e]));
  const planned = new Map<AttachmentSuggestion, ConnectionPlan>();
  for (const [target, rows] of buildRows(input.lifecycles, exec)) {
    for (const [row, plan] of planPosition(input, exec, target, rows))
      for (const s of row.suggestions) planned.set(s, plan);
  }
  return {
    ...input.lifecycles,
    suggestions: input.lifecycles.suggestions.map((s) => {
      const plan = planned.get(s);
      return plan ? { ...s, plan } : { ...s };
    }),
  };
}

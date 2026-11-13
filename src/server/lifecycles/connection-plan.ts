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
import { underlyingSymbol } from "../../shared/symbols.js";
import { compareLifecycleTime } from "./chronology.js";
import {
  compareByTime,
  isRollRelease,
  sharesSoldAfter,
  spreadLeg,
} from "./connection-plan-reasons.js";
import { scopeTo } from "./connection-plan-scope.js";
import { refKey } from "./membership.js";
import { shareAvailability } from "./project.js";
import { validateLifecycleDecision } from "./validate-decision.js";

export interface PlanInput {
  ledger: LedgerSnapshot;
  projection: Projection;
  decisions: readonly Decision[];
  lifecycles: LifecycleProjection;
  origins?: Projection | undefined;
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

interface BuiltRows {
  byPosition: Map<string, PlanRow[]>;
  /** Rows that more than one position could cover, with those positions. */
  multiple: Array<{ row: PlanRow; candidates: string[] }>;
}

const underlyingOf = (e: Execution) =>
  e.instrument.underlying ?? e.instrument.symbol;

/** Positions whose shares, ignoring call reservations, could have covered the whole row. */
function unreservedPositions(
  input: PlanInput,
  row: PlanRow,
  suggestions: AttachmentSuggestion[],
): string[] {
  const multiplier = new Decimal(row.opening.instrument.multiplier ?? "0");
  if (!multiplier.gt(0)) return [];
  const needed = suggestions
    .reduce(
      (total, s) => total.plus(new Decimal(s.quantity).abs()),
      new Decimal(0),
    )
    .times(multiplier);
  const unreserved = shareAvailability(input.ledger, input.lifecycles, false);
  return input.lifecycles.lifecycles
    .filter(
      (l) =>
        l.account === row.opening.account &&
        l.currency === row.opening.currency &&
        l.underlyingKey === `value:${underlyingOf(row.opening)}` &&
        unreserved(l.id, row.opening).gte(needed),
    )
    .map((l) => l.id)
    .sort();
}

function buildRows(input: PlanInput, exec: Map<string, Execution>): BuiltRows {
  const { lifecycles } = input;
  const grouped = new Map<string, AttachmentSuggestion[]>();
  for (const s of lifecycles.suggestions) {
    const key = planRowKey(s, exec);
    grouped.set(key, [...(grouped.get(key) ?? []), s]);
  }
  const byPosition = new Map<string, PlanRow[]>();
  const multiple: BuiltRows["multiple"] = [];
  for (const suggestions of grouped.values()) {
    const first = suggestions[0];
    const instrumentKey =
      first && exec.get(first.callOpening.executionKey)?.instrument.key;
    if (!first || !instrumentKey) continue;
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
    const row: PlanRow = { suggestions, members, opening };
    let candidates = first.candidateLifecycleIds.filter((id) =>
      suggestions.every((s) => s.candidateLifecycleIds.includes(id)),
    );
    if (
      !candidates.length &&
      suggestions.some((s) =>
        s.reasons.includes("SHARES_RESERVED_BY_OTHER_CALLS"),
      )
    )
      candidates = unreservedPositions(input, row, suggestions);
    const [target] = candidates;
    if (!target) continue;
    if (candidates.length > 1) {
      multiple.push({ row, candidates });
      continue;
    }
    byPosition.set(target, [...(byPosition.get(target) ?? []), row]);
  }
  for (const rows of byPosition.values())
    rows.sort((a, b) => compareOpenings(a.opening, b.opening));
  return { byPosition, multiple };
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
  pending: AllocationRef[],
): ConnectionPlan {
  const earlier = accepted.filter((a) =>
    closesAtOrBefore(closeOf(a, exec), row.opening),
  );
  const earlierRefs = earlier.flatMap((a) => openRef(a) ?? []);
  const dependsOn = mergeRefs(earlierRefs, pending);
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
  if (earlierRefs.length)
    return {
      action: "connect",
      lifecycleId: target,
      reason: "COVERED_AFTER_EARLIER",
      dependsOn,
    };
  return {
    action: "connect",
    lifecycleId: target,
    reason: "COVERED",
    ...(dependsOn.length ? { dependsOn } : {}),
  };
}

function mergeRefs(...lists: AllocationRef[][]): AllocationRef[] {
  const byKey = new Map(lists.flat().map((r) => [refKey(r), r]));
  return [...byKey.values()];
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
  pending: AllocationRef[],
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
    ...(pending.length ? { dependsOn: pending } : {}),
  };
}

/** Calls in the position, or about to be, whose time against this opening cannot be ordered. */
function orderUnknown(
  row: PlanRow,
  others: PlanRow[],
  exec: Map<string, Execution>,
): boolean {
  return others.some((o) =>
    o.members.some((m) => {
      const e = exec.get(m.allocation.executionKey);
      return (
        e !== undefined &&
        e.instrument.putCall === "C" &&
        e.instrument.key !== row.opening.instrument.key &&
        e.date === row.opening.date &&
        compareLifecycleTime(e, row.opening) === null
      );
    }),
  );
}

/** The row with its fills up to and including the nth; the last prefix is the whole row. */
function fillPrefixes(row: PlanRow, exec: Map<string, Execution>): PlanRow[] {
  const fills = row.suggestions
    .flatMap((s) => {
      const e = exec.get(s.callOpening.executionKey);
      return e ? [e] : [];
    })
    .sort(compareOpenings);
  return fills.map((_, i) => {
    if (i === fills.length - 1) return row;
    const included = new Set(fills.slice(0, i + 1).map((f) => f.key));
    return {
      ...row,
      members: row.members.filter(
        (m) =>
          m.allocation.role === "open" &&
          included.has(m.allocation.executionKey),
      ),
    };
  });
}

/**
 * Free shares in the target position when the row opens, from the same
 * coverage code the projection uses. The earlier accepted rows are assumed
 * connected (their members moved into the position), so the figure matches
 * what the user will see once those connections are saved, not the saved state.
 */
function freeSharesAt(
  input: PlanInput,
  target: string,
  accepted: PlanRow[],
  row: PlanRow,
): string {
  const moved = new Set(
    accepted.flatMap((a) => a.members.map((m) => refKey(m.allocation))),
  );
  const assumed: LifecycleProjection = {
    ...input.lifecycles,
    members: [
      ...input.lifecycles.members.filter(
        (m) => !moved.has(refKey(m.allocation)),
      ),
      ...accepted.flatMap((a) =>
        a.members.map((m) => ({ ...m, lifecycleId: target })),
      ),
    ],
  };
  return shareAvailability(input.ledger, assumed)(
    target,
    row.opening,
  ).toString();
}

function planPosition(
  whole: PlanInput,
  exec: Map<string, Execution>,
  target: string,
  rows: PlanRow[],
  multiple: BuiltRows["multiple"],
): Map<PlanRow, ConnectionPlan> {
  const plans = new Map<PlanRow, ConnectionPlan>();
  const first = rows[0];
  // Hypothetical checks run on this account's trades in this underlying only.
  const input: PlanInput = first
    ? {
        ...whole,
        ...scopeTo(
          whole,
          first.opening.account,
          underlyingSymbol(first.opening.instrument),
        ),
      }
    : whole;
  const existing = existingRows(target, input.lifecycles, exec);
  const separates: PlanRow[] = [];
  const manuals: PlanRow[] = [];
  const accepted: PlanRow[] = [];
  rows.forEach((row, n) => {
    const choices = multiple
      .filter(
        (m) =>
          m.candidates.includes(target) &&
          compareOpenings(m.row.opening, row.opening) < 0,
      )
      .map((m) => m.row);
    // Manual rows are assumed kept apart so they do not skew the order check for later rows.
    const kept = [...separates, ...manuals, ...choices].map((s, i) =>
      hypotheticalDecision(
        `plan:sep:${n}:${i}`,
        Number.MAX_SAFE_INTEGER - n - i - 1,
        false,
        [s],
        target,
      ),
    );
    const pending = [...choices, ...manuals].flatMap((r) => openRef(r) ?? []);
    const judged = (members: PlanRow) =>
      hypotheticalDecision(
        "__validate__", // the id decisions treat as a live check: failures throw
        Number.MAX_SAFE_INTEGER,
        true,
        [...accepted, members],
        target,
      );
    const others = [...existing, ...rows.filter((r) => r !== row)];
    const verdicts = orderUnknown(row, others, exec)
      ? null
      : fillPrefixes(row, exec).map((p) => connects(input, kept, judged(p)));
    const manualReason =
      verdicts === null
        ? "ORDER_UNKNOWN"
        : new Set(verdicts).size > 1
          ? "PARTIAL"
          : null;
    if (manualReason) {
      plans.set(row, {
        action: "manual",
        lifecycleId: target,
        reason: manualReason,
        ...(pending.length ? { dependsOn: pending } : {}),
      });
      manuals.push(row);
      return;
    }
    const verdict = verdicts?.at(-1)
      ? connectPlan(target, row, accepted, existing, exec, pending)
      : separatePlan(
          target,
          row,
          accepted,
          existing,
          input.lifecycles,
          exec,
          pending,
        );
    const pairedWith = spreadLeg(
      row.opening,
      input.ledger.executions,
      input.projection.allocations,
    );
    const sized =
      verdict.action === "connect"
        ? {
            ...verdict,
            sharesAtOpening: freeSharesAt(input, target, accepted, row),
          }
        : verdict;
    plans.set(row, pairedWith ? { ...sized, pairedWith } : sized);
    if (verdict.action === "connect") accepted.push(row);
    else separates.push(row);
  });
  return plans;
}

/** Recommends, per review row, connecting to or keeping a call apart from its candidate position. */
export function planConnections(input: PlanInput): LifecycleProjection {
  const exec = new Map(input.ledger.executions.map((e) => [e.key, e]));
  const planned = new Map<AttachmentSuggestion, ConnectionPlan>();
  const { byPosition, multiple } = buildRows(input, exec);
  for (const [target, rows] of byPosition) {
    for (const [row, plan] of planPosition(input, exec, target, rows, multiple))
      for (const s of row.suggestions) planned.set(s, plan);
  }
  for (const { row } of multiple)
    for (const s of row.suggestions)
      planned.set(s, {
        action: "manual",
        lifecycleId: null,
        reason: "MULTIPLE_POSITIONS",
      });
  return {
    ...input.lifecycles,
    suggestions: input.lifecycles.suggestions.map((s) => {
      const plan = planned.get(s);
      return plan ? { ...s, plan } : { ...s };
    }),
  };
}

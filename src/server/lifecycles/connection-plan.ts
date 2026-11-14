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
import { disposalLot } from "./connection-plan-evidence.js";
import {
  compareByTime,
  rollReleasedCall,
  sharesSoldAfter,
  spreadLeg,
} from "./connection-plan-reasons.js";
import { scopeTo } from "./connection-plan-scope.js";
import { refKey } from "./membership.js";
import {
  netShareAvailability,
  shareAvailability,
  shareLotIds,
} from "./project.js";
import { validateLifecycleDecision } from "./validate-decision.js";

export interface PlanInput {
  ledger: LedgerSnapshot;
  projection: Projection;
  decisions: readonly Decision[];
  lifecycles: LifecycleProjection;
  origins?: Projection | undefined;
  retainedAnchors?: readonly RetainedLifecycleAnchor[];
  /** Judge every hypothetical against the whole ledger; used to check that scoping changes nothing. */
  unscoped?: boolean;
  /** Receives an unexpected planning failure; defaults to a JSON line on stderr. */
  onError?: (error: unknown, scope: string) => void;
}

function reportPlanError(error: unknown, scope: string): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      msg: "Connection planning failed; rows left without a recommendation.",
      scope,
      error: error instanceof Error ? error.stack : String(error),
    })}\n`,
  );
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

/**
 * The lot whose shares this call's assignment or combo buy-back sold, by
 * IBKR's FIFO on that sale's date, when that lot already held the shares
 * when the call opened. It decides the row's position over any lot that only
 * looked free at opening; the user's lots then match IBKR's tax lots.
 */
function soldLot(
  input: PlanInput,
  exec: Map<string, Execution>,
  held: ReturnType<typeof shareAvailability>,
  row: PlanRow,
  call: { strategyId: string; instrumentKey: string },
): string | undefined {
  const lot = disposalLot(
    call,
    input.lifecycles.members,
    input.projection,
    exec,
  );
  if (!lot) return undefined;
  const needed = row.suggestions
    .reduce((t, s) => t.plus(new Decimal(s.quantity).abs()), new Decimal(0))
    .times(row.opening.instrument.multiplier ?? "0");
  return needed.gt(0) && held(lot, row.opening).gte(needed) ? lot : undefined;
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
  const held = shareAvailability(input.ledger, lifecycles, false);
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
    const sold = soldLot(input, exec, held, row, {
      strategyId: first.callOpening.strategyId,
      instrumentKey,
    });
    // The sale only chooses among lots the projection already offers, or the
    // lot the call's own assignment already merged it into; it never widens them.
    if (
      sold &&
      (candidates.includes(sold) || members.some((m) => m.lifecycleId === sold))
    )
      candidates = [sold];
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
  /** The position to connect to; null keeps each member in its own lifecycle, as "Keep separate" saves it. */
  lifecycleId: string | null,
): Decision {
  const assignments = new Map<
    string,
    { allocation: AllocationRef; lifecycleId: string; quantity: string }
  >();
  for (const member of rows.flatMap((r) => r.members)) {
    const assigned = lifecycleId ?? member.lifecycleId;
    const key = JSON.stringify([refKey(member.allocation), assigned]);
    const previous = assignments.get(key);
    assignments.set(key, {
      allocation: member.allocation,
      lifecycleId: assigned,
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
  const released = rollReleasedCall(
    row.opening,
    shortCallOpenings([...existing, ...accepted], exec),
  );
  if (released)
    return {
      action: "connect",
      lifecycleId: target,
      reason: "ROLL_RELEASE",
      heldBy: released.ref,
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
  if (!held && !sharesSold)
    throw new Error(
      `Planner bug: ${row.opening.key} was judged separate but no earlier call holds the shares and no shares were sold.`,
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
 * Free shares of the target's underlying when the row opens, summed over all
 * its share lots as the coverage check counts them. The earlier accepted rows
 * are assumed connected (their members moved into their positions), so the
 * figure matches what the user will see once those connections are saved.
 */
function freeSharesAt(
  input: PlanInput,
  exec: Map<string, Execution>,
  target: string,
  accepted: ReadonlyMap<string, PlanRow[]>,
  row: PlanRow,
): string {
  const rows = [...accepted].flatMap(([id, list]) =>
    list.flatMap((a) => a.members.map((m) => ({ ...m, lifecycleId: id }))),
  );
  const moved = new Set(rows.map((m) => refKey(m.allocation)));
  const assumed: LifecycleProjection = {
    ...input.lifecycles,
    members: [
      ...input.lifecycles.members.filter(
        (m) => !moved.has(refKey(m.allocation)),
      ),
      ...rows,
    ],
  };
  const net = netShareAvailability(input.ledger, assumed);
  return Decimal.max(
    0,
    shareLotIds(input.lifecycles, exec, target).reduce(
      (total, id) => total.plus(net(id, row.opening)),
      new Decimal(0),
    ),
  ).toFixed();
}

interface CandidateRow {
  row: PlanRow;
  candidates: string[];
}

/** Judge all positions together so an earlier connection reserves its shares
 * before a later row with several candidate positions is considered. */
function planScope(
  whole: PlanInput,
  exec: Map<string, Execution>,
  entries: readonly CandidateRow[],
): Map<PlanRow, ConnectionPlan> {
  const plans = new Map<PlanRow, ConnectionPlan>();
  const first = entries[0]?.row;
  const input: PlanInput =
    first && !whole.unscoped
      ? {
          ...whole,
          ...scopeTo(
            whole,
            first.opening.account,
            underlyingSymbol(first.opening.instrument),
          ),
        }
      : whole;
  const assumed: Decision[] = [];
  const accepted = new Map<string, PlanRow[]>();
  const manuals: CandidateRow[] = [];
  const sequence = Math.max(0, ...input.decisions.map((d) => d.sequence));
  const ordered = [...entries].sort((a, b) =>
    compareOpenings(a.row.opening, b.row.opening),
  );
  ordered.forEach(({ row, candidates }, n) => {
    const judged = (members: PlanRow, target: string) =>
      hypotheticalDecision(
        "__validate__",
        sequence + n + 1,
        true,
        [members],
        target,
      );
    const verdicts = candidates.map((target) => {
      const existing = existingRows(target, input.lifecycles, exec);
      const others = [
        ...existing,
        ...entries
          .filter((e) => e.row !== row && e.candidates.includes(target))
          .map((e) => e.row),
      ];
      const fills = orderUnknown(row, others, exec)
        ? null
        : fillPrefixes(row, exec).map((p) =>
            connects(input, assumed, judged(p, target)),
          );
      const shares = new Decimal(
        freeSharesAt(input, exec, target, accepted, row),
      );
      const firstFillShares = row.suggestions
        .filter((s) => s.callOpening.executionKey === row.opening.key)
        .reduce(
          (total, s) => total.plus(new Decimal(s.quantity).abs()),
          new Decimal(0),
        )
        .times(row.opening.instrument.multiplier ?? "0");
      return {
        target,
        existing,
        fills,
        partialFill: shares.gt(0) && shares.lt(firstFillShares),
      };
    });
    const viable = verdicts.filter((v) => v.fills?.every(Boolean));
    const unknown = verdicts.some((v) => v.fills === null);
    const partial = verdicts.some(
      (v) => v.partialFill || (v.fills && new Set(v.fills).size > 1),
    );
    const chosen = viable[0] ?? verdicts[0];
    if (!chosen) return;
    const target = chosen.target;
    const holders = accepted.get(target) ?? [];
    const pending = manuals
      .filter((m) => m.candidates.some((id) => candidates.includes(id)))
      .flatMap((m) => openRef(m.row) ?? []);
    let plan: ConnectionPlan;
    if (unknown || partial || viable.length > 1) {
      plan = {
        action: "manual",
        lifecycleId: candidates.length === 1 ? target : null,
        reason: unknown
          ? "ORDER_UNKNOWN"
          : partial
            ? "PARTIAL"
            : "MULTIPLE_POSITIONS",
        ...(pending.length ? { dependsOn: pending } : {}),
      };
      manuals.push({ row, candidates });
    } else if (viable.length === 1) {
      plan = {
        ...connectPlan(target, row, holders, chosen.existing, exec, pending),
        sharesAtOpening: freeSharesAt(input, exec, target, accepted, row),
      };
      accepted.set(target, [...holders, row]);
    } else {
      // Coverage is counted across the underlying's lots, so the call that
      // took the shares may sit on any of them.
      const lots = shareLotIds(input.lifecycles, exec, target);
      plan = separatePlan(
        target,
        row,
        lots.flatMap((id) => accepted.get(id) ?? []),
        lots.flatMap((id) => existingRows(id, input.lifecycles, exec)),
        input.lifecycles,
        exec,
        pending,
      );
    }
    const pairedWith = spreadLeg(
      row.opening,
      input.ledger.executions,
      input.projection.allocations,
    );
    plans.set(row, pairedWith ? { ...plan, pairedWith } : plan);
    // Manual choices stay separate for the hypothetical checks, and remain
    // explicit dependencies. Recommendations never save real decisions.
    assumed.push(
      hypotheticalDecision(
        `plan:${n}`,
        sequence + n + 1,
        plan.action === "connect",
        [row],
        plan.action === "connect" ? target : null,
      ),
    );
  });
  return plans;
}

/** Recommends connections in chronology across every share position in a scope. */
function planAll(input: PlanInput): LifecycleProjection {
  const exec = new Map(input.ledger.executions.map((e) => [e.key, e]));
  const planned = new Map<AttachmentSuggestion, ConnectionPlan>();
  const { byPosition, multiple } = buildRows(input, exec);
  const scopes = new Map<string, CandidateRow[]>();
  const entries = [
    ...[...byPosition].flatMap(([target, rows]) =>
      rows.map((row) => ({ row, candidates: [target] })),
    ),
    ...multiple,
  ];
  for (const entry of entries) {
    const e = entry.row.opening;
    const key = JSON.stringify([
      e.account,
      e.currency,
      underlyingSymbol(e.instrument),
    ]);
    scopes.set(key, [...(scopes.get(key) ?? []), entry]);
  }
  for (const [scope, rows] of scopes) {
    try {
      for (const [row, plan] of planScope(input, exec, rows))
        for (const s of row.suggestions) planned.set(s, plan);
    } catch (error) {
      // A planning bug must never abort a rebuild: this ticker's rows get no
      // plan. Its lots share coverage, so they cannot be planned apart.
      (input.onError ?? reportPlanError)(error, scope);
    }
  }
  return {
    ...input.lifecycles,
    suggestions: input.lifecycles.suggestions.map((s) => {
      const plan = planned.get(s);
      return plan ? { ...s, plan } : { ...s };
    }),
  };
}

/** Never throws: a planning failure leaves the input lifecycles without plans. */
export function planConnections(input: PlanInput): LifecycleProjection {
  try {
    return planAll(input);
  } catch (error) {
    (input.onError ?? reportPlanError)(error, "all");
    return input.lifecycles;
  }
}

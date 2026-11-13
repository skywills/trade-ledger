import { Decimal } from "decimal.js";
import type { Decision, Execution, Projection } from "../../shared/domain.js";
import {
  LifecycleAttachmentPayloadSchema,
  LifecycleMembershipPayloadSchema,
} from "../../shared/lifecycles.js";
import { compareLifecycleTime } from "./chronology.js";

/** Strategy of each user-connected covered call -> the share lifecycle chosen. */
export function connectedCallTargets(
  decisions: readonly Decision[],
): Map<string, string> {
  const targets = new Map<string, string>();
  for (const d of decisions) {
    if (d.kind === "lifecycle_attachment") {
      const p = LifecycleAttachmentPayloadSchema.safeParse(d.payload);
      const only = p.success && p.data.targets.length === 1;
      if (p.success && only && p.data.targets[0])
        targets.set(p.data.opening.strategyId, p.data.targets[0].lifecycleId);
    }
    if (d.kind === "lifecycle_membership") {
      const p = LifecycleMembershipPayloadSchema.safeParse(d.payload);
      if (!p.success || !p.data.requireCallCoverage) continue;
      for (const a of p.data.assignments)
        if (a.allocation.role === "open")
          targets.set(a.allocation.strategyId, a.lifecycleId);
    }
  }
  return targets;
}

/**
 * The share lifecycle a stock close belongs to by the user's own pairing:
 * the call-away of a connected call, or a sale in the same instant as a
 * connected call's buy-back. Undefined when there is no such evidence or it
 * points at more than one lifecycle; FIFO then decides.
 */
export function connectedLotOwner(
  close: { strategyId: string; executionKey: string },
  execution: Execution,
  projection: Projection,
  exec: ReadonlyMap<string, Execution>,
  targets: ReadonlyMap<string, string>,
): string | undefined {
  const owners = new Set<string>();
  for (const link of projection.links) {
    if (!["assignment", "exercise"].includes(link.type)) continue;
    if (link.to !== close.strategyId) continue;
    const referenced = link.sources.some((s) =>
      execution.sources.some(
        (t) => s.importId === t.importId && s.rowNumber === t.rowNumber,
      ),
    );
    const target = targets.get(link.from);
    if (referenced && target) owners.add(target);
  }
  for (const a of projection.allocations) {
    const target = targets.get(a.strategyId);
    if (!target || a.role !== "close") continue;
    const e = exec.get(a.executionKey);
    if (
      e?.instrument.putCall === "C" &&
      e.event === "trade" &&
      new Decimal(a.quantity).gt(0) &&
      compareLifecycleTime(e, execution) === 0
    )
      owners.add(target);
  }
  return owners.size === 1 ? [...owners][0] : undefined;
}

interface ShareMember {
  lifecycleId: string;
  allocation: { strategyId: string; executionKey: string; role: string };
  quantity: string;
}

/** Share balance never goes below zero in time order (opens first at ties). */
function sharesStayCovered(
  members: readonly ShareMember[],
  exec: ReadonlyMap<string, Execution>,
): boolean {
  const rows = members
    .map((m) => ({ m, e: exec.get(m.allocation.executionKey) }))
    .filter(
      (r): r is { m: ShareMember; e: Execution } =>
        r.e?.instrument.assetClass === "STK",
    )
    .sort(
      (a, b) =>
        (compareLifecycleTime(a.e, b.e) ?? 0) ||
        (a.m.allocation.role === "open" ? 0 : 1) -
          (b.m.allocation.role === "open" ? 0 : 1),
    );
  const held = new Map<string, Decimal>();
  for (const { m, e } of rows) {
    const next = (held.get(e.instrument.key) ?? new Decimal(0)).plus(
      m.quantity,
    );
    if (next.isNegative()) return false;
    held.set(e.instrument.key, next);
  }
  return true;
}

/**
 * Moves share closes to the lifecycle the user's covered-call pairing implies
 * when that differs from the lot IBKR's FIFO chose. All moves apply together
 * and only if every affected lifecycle keeps a non-negative share balance;
 * otherwise FIFO stands. Returns the lifecycles whose shares no longer follow
 * IBKR's tax lots.
 */
export function applyConnectedLotOwnership(
  members: ShareMember[],
  projection: Projection,
  exec: ReadonlyMap<string, Execution>,
  targets: ReadonlyMap<string, string>,
): Set<string> {
  const moves: Array<{ member: ShareMember; from: string; to: string }> = [];
  for (const member of members) {
    if (member.allocation.role !== "close") continue;
    const e = exec.get(member.allocation.executionKey);
    if (e?.instrument.assetClass !== "STK") continue;
    const owner = connectedLotOwner(
      member.allocation,
      e,
      projection,
      exec,
      targets,
    );
    if (owner && owner !== member.lifecycleId)
      moves.push({ member, from: member.lifecycleId, to: owner });
  }
  if (!moves.length) return new Set();
  for (const move of moves) move.member.lifecycleId = move.to;
  const affected = new Set(moves.flatMap((m) => [m.from, m.to]));
  const valid = [...affected].every((id) =>
    sharesStayCovered(
      members.filter((m) => m.lifecycleId === id),
      exec,
    ),
  );
  if (!valid) {
    for (const move of moves) move.member.lifecycleId = move.from;
    return new Set();
  }
  return affected;
}

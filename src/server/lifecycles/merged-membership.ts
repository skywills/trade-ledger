import { Decimal } from "decimal.js";
import type { Allocation, Decision } from "../../shared/domain.js";
import { groupBy } from "../../shared/group-by.js";
import type {
  AllocationRef,
  LifecycleMember,
} from "../../shared/lifecycles.js";
import { LifecycleMembershipPayloadSchema } from "../../shared/lifecycles.js";
import { presentationMergeResolver } from "../strategies/presentation-merges.js";
import { indexMembersByAllocation, refKey, sum } from "./membership.js";

type Assignment = {
  allocation: AllocationRef;
  lifecycleId: string;
  quantity: string;
};

/** Translate one complete partition of a merged allocation onto its origin slices.
 * Keep the original owners and their broker amounts wherever the requested
 * quantities allow, then transfer only the remaining units.
 */
export function expandMergedMembership(
  targets: Assignment[],
  sources: readonly Allocation[],
  members: ReadonlyMap<string, LifecycleMember[]>,
): Assignment[] {
  if (sources.length === 1 && sources[0]) {
    const { strategyId, executionKey, role } = sources[0];
    return targets.map((t) => ({
      ...t,
      allocation: { strategyId, executionKey, role },
    }));
  }
  if (
    sources.length === 0 ||
    !new Decimal(sum(targets.map((t) => t.quantity))).eq(
      sum(sources.map((s) => s.quantity)),
    ) ||
    new Set(targets.map((t) => t.lifecycleId)).size !== targets.length
  )
    return targets;
  const negative = new Decimal(sources[0]?.quantity ?? "0").isNegative();
  if (
    targets.some(
      (t) =>
        new Decimal(t.quantity).isZero() ||
        new Decimal(t.quantity).isNegative() !== negative,
    )
  )
    return targets;
  const needed = targets.map((t) => ({
    id: t.lifecycleId,
    quantity: new Decimal(t.quantity).abs(),
  }));
  const result: Assignment[] = [];
  const pieces = sources.map((a) => ({
    a,
    left: new Decimal(a.quantity).abs(),
    byOwner: new Map<string, Decimal>(),
  }));
  const take = (
    piece: (typeof pieces)[number],
    target: (typeof needed)[number],
    limit: Decimal,
  ) => {
    const quantity = Decimal.min(piece.left, target.quantity, limit);
    if (quantity.isZero()) return;
    target.quantity = target.quantity.minus(quantity);
    piece.left = piece.left.minus(quantity);
    piece.byOwner.set(
      target.id,
      (piece.byOwner.get(target.id) ?? new Decimal(0)).plus(quantity),
    );
  };
  for (const piece of pieces) {
    for (const member of members.get(refKey(piece.a)) ?? []) {
      const target = needed.find((t) => t.id === member.lifecycleId);
      if (target) take(piece, target, new Decimal(member.quantity).abs());
    }
  }
  for (const piece of pieces) {
    for (const target of needed) take(piece, target, piece.left);
    const { strategyId, executionKey, role } = piece.a;
    for (const [lifecycleId, units] of piece.byOwner) {
      result.push({
        allocation: { strategyId, executionKey, role },
        lifecycleId,
        quantity: (negative ? units.negated() : units).toFixed(),
      });
    }
  }
  return result;
}

/** Replay the presentation that each membership's allocation references were
 * saved against. Later and superseding merges change the final display only. */
export function replayMergedMembership(
  decisions: readonly Decision[],
  history: readonly Decision[],
  scopes: ReadonlyMap<
    string,
    { id: string; account: string; currency: string }
  >,
  allocations: readonly Allocation[],
  members: readonly LifecycleMember[],
): Decision[] {
  const ordered = (a: Decision, b: Decision) =>
    a.sequence - b.sequence || a.id.localeCompare(b.id);
  const mergeIds = new Set(
    history.filter((d) => d.kind === "group_merge").map((d) => d.id),
  );
  const timeline = history
    .filter(
      (d) =>
        mergeIds.has(d.id) ||
        (d.supersedesId !== null && mergeIds.has(d.supersedesId)),
    )
    .sort(ordered);
  const active = new Map<string, Decision>();
  const byAllocation = indexMembersByAllocation(members);
  let sources: Map<string, Allocation[]> | undefined;
  let cursor = 0;
  return [...decisions].sort(ordered).map((d) => {
    if (d.kind !== "lifecycle_membership") return d;
    for (
      let event = timeline[cursor];
      event && event.sequence < d.sequence;
      event = timeline[++cursor]
    ) {
      if (event.supersedesId !== null) active.delete(event.supersedesId);
      if (event.kind === "group_merge") active.set(event.id, event);
      sources = undefined;
    }
    if (!active.size) return d;
    const parsed = LifecycleMembershipPayloadSchema.safeParse(d.payload);
    if (!parsed.success) return d;
    if (!sources) {
      const mergedId = presentationMergeResolver(scopes, [...active.values()]);
      sources = groupBy(allocations, (a) =>
        refKey({ ...a, strategyId: mergedId(a.strategyId) }),
      );
    }
    const groups = groupBy(parsed.data.assignments, (a) =>
      refKey(a.allocation),
    );
    const assignments = [];
    for (const [key, targets] of groups) {
      assignments.push(
        ...expandMergedMembership(
          targets,
          sources.get(key) ?? [],
          byAllocation,
        ),
      );
    }
    return { ...d, payload: { ...d.payload, assignments } };
  });
}

import { Decimal } from "decimal.js";
import type { Allocation } from "../../shared/domain.js";
import type {
  AllocationRef,
  LifecycleMember,
} from "../../shared/lifecycles.js";
import { refKey, sum } from "./membership.js";

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
  if (
    sources.length < 2 ||
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

import { Decimal } from "decimal.js";
import type {
  Allocation,
  Issue,
  LedgerSnapshot,
  Projection,
} from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type {
  AllocationRef,
  LifecycleMember,
} from "../../shared/lifecycles.js";
import { splitAmount } from "../strategies/allocation.js";
export const refKey = (a: AllocationRef) =>
  JSON.stringify([a.strategyId, a.executionKey, a.role]);
export const sum = (v: readonly string[]) =>
  v.reduce((s, n) => s.plus(n), new Decimal(0)).toFixed();
export function partition(
  a: Allocation,
  targets: readonly { lifecycleId: string; quantity: string }[],
  sources: LifecycleMember["sources"],
): LifecycleMember[] {
  const parts = targets.map((t) => ({
    strategyId: t.lifecycleId,
    quantity: t.quantity,
  }));
  const cash = new Map(
    splitAmount(a.netCash, parts).map((t) => [t.strategyId, t.amount]),
  );
  const pnl =
    a.brokerPnl === null
      ? null
      : new Map(
          splitAmount(a.brokerPnl, parts).map((t) => [t.strategyId, t.amount]),
        );
  if (
    new Set(targets.map((t) => t.lifecycleId)).size !== targets.length ||
    !new Decimal(sum(targets.map((t) => t.quantity))).eq(a.quantity) ||
    targets.some(
      (t) =>
        new Decimal(t.quantity).isZero() ||
        new Decimal(t.quantity).isNegative() !==
          new Decimal(a.quantity).isNegative(),
    )
  )
    throw new AppError(
      "INVALID_LIFECYCLE_MEMBERSHIP",
      "Quantities must partition the entire source allocation with matching signs.",
      400,
    );
  return targets.map((t) => ({
    lifecycleId: t.lifecycleId,
    allocation: {
      strategyId: a.strategyId,
      executionKey: a.executionKey,
      role: a.role,
    },
    quantity: new Decimal(t.quantity).toFixed(),
    netCash: cash.get(t.lifecycleId) ?? "0",
    brokerPnl: pnl?.get(t.lifecycleId) ?? null,
    estimated: a.pnlEstimated || targets.length > 1,
    ...(targets.length > 1
      ? { pnlAttribution: "estimated" as const }
      : a.pnlAttribution === undefined
        ? {}
        : { pnlAttribution: a.pnlAttribution }),
    sources,
  }));
}
export function validateMembership(
  _ledger: LedgerSnapshot,
  projection: Projection,
  members: readonly LifecycleMember[],
): Issue[] {
  const issues: Issue[] = [];
  const valid = new Set(projection.allocations.map(refKey));
  for (const a of projection.allocations) {
    const m = members.filter((m) => refKey(m.allocation) === refKey(a));
    if (
      !new Decimal(sum(m.map((t) => t.quantity))).eq(a.quantity) ||
      !new Decimal(sum(m.map((t) => t.netCash))).eq(a.netCash) ||
      (a.brokerPnl !== null &&
        (m.some((t) => t.brokerPnl === null) ||
          !new Decimal(sum(m.map((t) => t.brokerPnl ?? "0"))).eq(a.brokerPnl)))
    )
      issues.push({
        key: `lifecycle:conservation:${refKey(a)}`,
        code: "LIFECYCLE_CONSERVATION",
        sources: [],
        severity: "error",
      });
  }
  for (const m of members)
    if (!valid.has(refKey(m.allocation)))
      issues.push({
        key: `lifecycle:orphan:${refKey(m.allocation)}`,
        code: "LIFECYCLE_ORPHAN",
        sources: m.sources,
        severity: "error",
      });
  return issues;
}

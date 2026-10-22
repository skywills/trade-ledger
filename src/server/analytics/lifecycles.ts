import type { Execution } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type { LifecycleProjection } from "../../shared/lifecycles.js";
import { splitAmount } from "../strategies/allocation.js";
import { Money, sum } from "./performance.js";
import type { AnalyticsSnapshot } from "./snapshot.js";

/** Adapt membership slices once; never recover lifecycle amounts from component totals. */
export function lifecycleSnapshot(
  snapshot: AnalyticsSnapshot,
): AnalyticsSnapshot {
  const projection = snapshot.projection;
  if (!projection) return snapshot;
  const data = projection.lifecycles;
  if (!data)
    throw new AppError(
      "LIFECYCLE_REBUILD_REQUIRED",
      "Rebuild this historical projection to calculate lifecycle analytics.",
      409,
    );
  return {
    ...snapshot,
    projection: {
      ...projection,
      strategies: data.lifecycles.map((cycle) => ({
        ...cycle,
        type: cycle.originStrategyType,
        ...(cycle.status === "closed" && !cycle.complete
          ? { brokerPnl: null, reconstructedPnl: null }
          : {}),
      })),
      allocations: data.members.map((member) => ({
        strategyId: member.lifecycleId,
        executionKey: member.allocation.executionKey,
        role: member.allocation.role,
        quantity: member.quantity,
        netCash: member.netCash,
        brokerPnl: member.brokerPnl,
        pnlEstimated: member.estimated,
        ...(member.pnlAttribution === undefined
          ? {}
          : { pnlAttribution: member.pnlAttribution }),
      })),
    },
  };
}

/** Retain one source execution row while reporting only the selected economic slices. */
export function lifecycleExecutions(
  snapshot: AnalyticsSnapshot,
  selectedIds: ReadonlySet<string>,
  executions: Execution[],
): Execution[] {
  const members = snapshot.projection?.lifecycles?.members ?? [];
  return executions.map((execution) => {
    const all = members.filter(
      (member) => member.allocation.executionKey === execution.key,
    );
    const selected = all.filter((member) =>
      selectedIds.has(member.lifecycleId),
    );
    if (selected.length === all.length) return execution;
    const weights = new Map<string, string>();
    for (const member of all)
      weights.set(
        member.lifecycleId,
        new Money(weights.get(member.lifecycleId) ?? 0)
          .plus(new Money(member.quantity).abs())
          .toFixed(),
      );
    const apportioned = (amount: string | null) =>
      amount === null
        ? null
        : sum(
            splitAmount(
              amount,
              [...weights].map(([strategyId, quantity]) => ({
                strategyId,
                quantity,
              })),
            )
              .filter((part) => selectedIds.has(part.strategyId))
              .map((part) => part.amount),
          );
    return {
      ...execution,
      quantity: sum(selected.map((member) => member.quantity)) ?? "0",
      netCash: sum(selected.map((member) => member.netCash)) ?? "0",
      brokerPnl: selected.every((member) => member.brokerPnl !== null)
        ? sum(selected.map((member) => member.brokerPnl))
        : null,
      proceeds: apportioned(execution.proceeds),
      commission: apportioned(execution.commission),
      taxes: apportioned(execution.taxes),
      basis: apportioned(execution.basis),
    };
  });
}

function covered(values: readonly (string | null)[]) {
  const known = values.filter((value): value is string => value !== null);
  return {
    value: known.length === values.length ? sum(known) : null,
    knownValue: sum(known),
    known: known.length,
    total: values.length,
  };
}

/** Campaigns group observations; they never create another win/loss observation. */
export function campaignSummary(
  projection: LifecycleProjection,
  campaignId: string,
) {
  const rows = projection.lifecycles.filter(
    (cycle) => cycle.campaignId === campaignId,
  );
  const completed = rows.filter((cycle) => cycle.status === "closed");
  const open = rows.filter(
    (cycle) => cycle.status === "open" || cycle.status === "partially_closed",
  );
  const broker = completed.map((cycle) =>
    cycle.complete ? cycle.brokerPnl : null,
  );
  const reconstructed = completed.map((cycle) =>
    cycle.complete ? cycle.reconstructedPnl : null,
  );
  const result = (values: (string | null)[]) => {
    const eligible = values.filter((value): value is string => value !== null);
    const wins = eligible.filter((value) => new Money(value).gt(0)).length;
    return {
      eligible: eligible.length,
      missing: values.length - eligible.length,
      wins,
      losses: eligible.filter((value) => new Money(value).lt(0)).length,
      breakeven: eligible.filter((value) => new Money(value).isZero()).length,
      winRatePct: eligible.length
        ? new Money(wins)
            .times(100)
            .div(eligible.length)
            .toDecimalPlaces(12)
            .toFixed()
        : null,
    };
  };
  return {
    campaignId,
    completed: completed.length,
    open: open.length,
    unresolved: rows.filter((cycle) => cycle.status === "unresolved").length,
    complete: completed.filter((cycle) => cycle.complete).length,
    missing: completed.filter((cycle) => !cycle.complete).length,
    broker: { ...result(broker), pnl: covered(broker) },
    reconstructed: { ...result(reconstructed), pnl: covered(reconstructed) },
    openValuation: covered(
      open.map(
        (cycle) =>
          projection.valuations.find((value) => value.lifecycleId === cycle.id)
            ?.totalPnl ?? null,
      ),
    ),
  };
}

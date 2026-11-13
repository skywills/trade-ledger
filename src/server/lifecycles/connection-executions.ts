import type { LifecycleProjection } from "../../shared/lifecycles.js";

/** Executions the connection review needs: member rows plus every execution a plan refers to. */
export function connectionExecutionKeys(
  projection: LifecycleProjection,
): Set<string> {
  const strategies = new Set(
    projection.suggestions.map((a) => a.callOpening.strategyId),
  );
  const targets = new Set(
    projection.suggestions.flatMap((a) => a.candidateLifecycleIds),
  );
  const keys = new Set(
    projection.members
      .filter(
        (m) =>
          strategies.has(m.allocation.strategyId) || targets.has(m.lifecycleId),
      )
      .map((m) => m.allocation.executionKey),
  );
  for (const { plan } of projection.suggestions) {
    if (!plan) continue;
    const referenced = [
      plan.heldBy?.executionKey,
      plan.sharesSold?.executionKey,
      plan.pairedWith?.executionKey,
      ...(plan.dependsOn ?? []).map((d) => d.executionKey),
    ];
    for (const key of referenced) if (key) keys.add(key);
  }
  return keys;
}

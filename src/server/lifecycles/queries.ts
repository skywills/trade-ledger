import { AppError } from "../../shared/errors.js";
import { campaignSummary } from "../analytics/lifecycles.js";
import type { AnalyticsSnapshot } from "../analytics/snapshot.js";

export function lifecycleProjection(snapshot: AnalyticsSnapshot) {
  if (snapshot.projection && !snapshot.projection.lifecycles)
    throw new AppError(
      "LIFECYCLE_REBUILD_REQUIRED",
      "Rebuild before viewing lifecycles.",
      409,
    );
  return snapshot.projection?.lifecycles;
}

export function selectLifecycleDetail(s: AnalyticsSnapshot, id: string) {
  const p = lifecycleProjection(s);
  const lifecycle = p?.lifecycles.find((l) => l.id === id);
  if (!p || !lifecycle)
    throw new AppError(
      "LIFECYCLE_NOT_FOUND",
      "This lifecycle is not in the active build.",
      404,
    );
  const members = p.members.filter((m) => m.lifecycleId === id);
  const keys = new Set([
    ...members.map((m) => m.allocation.executionKey),
    ...p.suggestions
      .filter((a) => a.candidateLifecycleIds.includes(id))
      .map((a) => a.callOpening.executionKey),
  ]);
  for (const suggestion of p.suggestions.filter((a) =>
    a.candidateLifecycleIds.includes(id),
  )) {
    const instrumentKey = s.ledger?.executions.find(
      (e) => e.key === suggestion.callOpening.executionKey,
    )?.instrument.key;
    for (const a of s.projection?.allocations ?? [])
      if (
        a.strategyId === suggestion.callOpening.strategyId &&
        s.ledger?.executions.some(
          (e) => e.key === a.executionKey && e.instrument.key === instrumentKey,
        )
      )
        keys.add(a.executionKey);
  }
  return {
    lifecycle,
    members,
    executions: s.ledger?.executions.filter((e) => keys.has(e.key)) ?? [],
    suggestions: p.suggestions.filter(
      (a) =>
        a.candidateLifecycleIds.includes(id) ||
        members.some(
          (m) => m.allocation.executionKey === a.callOpening.executionKey,
        ),
    ),
    valuation: p.valuations.find((v) => v.lifecycleId === id) ?? null,
    campaigns: p.campaigns,
  };
}

export function selectCampaignDetail(s: AnalyticsSnapshot, id: string) {
  const p = lifecycleProjection(s);
  const campaign = p?.campaigns.find((c) => c.id === id);
  if (!p || !campaign)
    throw new AppError(
      "CAMPAIGN_NOT_FOUND",
      "This campaign is not in the active build.",
      404,
    );
  return {
    campaign,
    cycles: p.lifecycles.filter((l) => l.campaignId === id),
    summary: campaignSummary(p, id),
  };
}

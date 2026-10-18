import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors.js";
import { checkBuild } from "../analytics/details.js";
import { campaignSummary } from "../analytics/lifecycles.js";
import { readAnalyticsSnapshot } from "../analytics/snapshot.js";
import { decisionWatermark } from "../decisions/service.js";
import type { Store } from "../storage/database.js";
export async function registerLifecycleRoutes(
  app: FastifyInstance,
  store: Store,
): Promise<void> {
  const snapshot = (request: FastifyRequest) =>
    store.db.transaction(() => {
      const snapshot = readAnalyticsSnapshot(store);
      const query = request.query as Record<string, unknown>;
      if (
        query.expectedBuildId !== undefined &&
        typeof query.expectedBuildId !== "string"
      )
        throw new AppError(
          "INVALID_INPUT",
          "expectedBuildId must be a string.",
          400,
        );
      checkBuild(snapshot, query.expectedBuildId as string | undefined);
      return {
        snapshot,
        meta: {
          buildId: snapshot.buildId,
          ledgerId: snapshot.ledgerId,
          stale: snapshot.stale,
          generatedAt: snapshot.generatedAt,
          watermark: decisionWatermark(store),
          rebuildRequired:
            !!snapshot.projection && !snapshot.projection.lifecycles,
        },
      };
    })();
  app.get("/api/lifecycles", (request) => {
    const { snapshot: s, meta } = snapshot(request);
    return { ...meta, lifecycles: s.projection?.lifecycles ?? null };
  });
  app.get("/api/lifecycles/:id", (request) => {
    const { snapshot: s, meta } = snapshot(request);
    if (meta.rebuildRequired)
      throw new AppError(
        "LIFECYCLE_REBUILD_REQUIRED",
        "Rebuild before viewing lifecycles.",
        409,
      );
    const { id } = request.params as { id: string };
    const p = s.projection?.lifecycles;
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
            (e) =>
              e.key === a.executionKey && e.instrument.key === instrumentKey,
          )
        )
          keys.add(a.executionKey);
    }
    return {
      ...meta,
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
  });
  app.get("/api/campaigns/:id", (request) => {
    const { snapshot: s, meta } = snapshot(request);
    const { id } = request.params as { id: string };
    const p = s.projection?.lifecycles;
    if (meta.rebuildRequired)
      throw new AppError(
        "LIFECYCLE_REBUILD_REQUIRED",
        "Rebuild before viewing campaigns.",
        409,
      );
    const campaign = p?.campaigns.find((c) => c.id === id);
    if (!p || !campaign)
      throw new AppError(
        "CAMPAIGN_NOT_FOUND",
        "This campaign is not in the active build.",
        404,
      );
    return {
      ...meta,
      campaign,
      cycles: p.lifecycles.filter((l) => l.campaignId === id),
      summary: campaignSummary(p, id),
    };
  });
}

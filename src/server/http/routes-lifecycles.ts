import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors.js";
import { checkBuild } from "../analytics/details.js";
import { readAnalyticsSnapshot } from "../analytics/snapshot.js";
import { decisionWatermark } from "../decisions/service.js";
import {
  selectCampaignDetail,
  selectLifecycleDetail,
} from "../lifecycles/queries.js";
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
    const { id } = request.params as { id: string };
    return { ...meta, ...selectLifecycleDetail(s, id) };
  });
  app.get("/api/campaigns/:id", (request) => {
    const { snapshot: s, meta } = snapshot(request);
    const { id } = request.params as { id: string };
    return { ...meta, ...selectCampaignDetail(s, id) };
  });
}

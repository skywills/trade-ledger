import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../../shared/errors.js";
import { previewProposal } from "../ai/proposal-preview.js";
import { ProposalSchema } from "../ai/proposals.js";
import { checkBuild } from "../analytics/details.js";
import { readAnalyticsSnapshot } from "../analytics/snapshot.js";
import { decisionWatermark } from "../decisions/service.js";
import { connectionExecutionKeys } from "../lifecycles/connection-executions.js";
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
  app.post("/api/lifecycles/connection-preview", async (request) => {
    const input = z
      .object({
        proposal: ProposalSchema,
        expectedBuildId: z.string().min(1),
        expectedWatermark: z.number().int().nonnegative(),
      })
      .safeParse(request.body);
    if (
      !input.success ||
      ![
        "lifecycle_attachment",
        "lifecycle_membership",
        "lifecycle_attachment_rejection",
      ].includes(input.data.proposal.kind)
    )
      throw new AppError(
        "INVALID_INPUT",
        "Choose a current call connection to review.",
        400,
      );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref();
    try {
      return await previewProposal(
        store,
        input.data.proposal,
        {
          buildId: input.data.expectedBuildId,
          watermark: input.data.expectedWatermark,
        },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
  });
  app.get("/api/lifecycles", (request) => {
    const { snapshot: s, meta } = snapshot(request);
    const projection = s.projection?.lifecycles;
    const keys = projection
      ? connectionExecutionKeys(projection)
      : new Set<string>();
    return {
      ...meta,
      lifecycles: projection ?? null,
      connectionExecutions:
        s.ledger?.executions.filter((e) => keys.has(e.key)) ?? [],
    };
  });
  app.get("/api/lifecycles/:id", (request) => {
    const { snapshot: s, meta } = snapshot(request);
    const { id } = request.params as { id: string };
    const detail = selectLifecycleDetail(s, id);
    const projection = s.projection?.lifecycles;
    const { account, currency, underlyingKey } = detail.lifecycle;
    const related = new Set(
      projection?.lifecycles
        .filter(
          (l) =>
            l.account === account &&
            l.currency === currency &&
            l.underlyingKey === underlyingKey,
        )
        .map((l) => l.id),
    );
    const memberKeys = new Set(
      projection?.members
        .filter((m) => related.has(m.lifecycleId))
        .map((m) => m.allocation.executionKey),
    );
    const membershipExecutions =
      s.ledger?.executions
        .filter((e) => memberKeys.has(e.key))
        .map((e) => ({
          key: e.key,
          date: e.date,
          instrument: e.instrument,
        })) ?? [];
    return { ...meta, ...detail, membershipExecutions };
  });
  app.get("/api/campaigns/:id", (request) => {
    const { snapshot: s, meta } = snapshot(request);
    const { id } = request.params as { id: string };
    return { ...meta, ...selectCampaignDetail(s, id) };
  });
}

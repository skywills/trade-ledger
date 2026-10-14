import type { FastifyInstance } from "fastify";
import {
  pageSlice,
  parsePageParams,
  parseSortSpec,
  sortWithAllowlist,
  toEnvelope,
} from "../../shared/api.js";
import { AppError } from "../../shared/errors.js";
import { activeProjection } from "../builds/service.js";
import { appendDecision, decisionWatermark } from "../decisions/service.js";
import type { Store } from "../storage/database.js";

function readExpectedWatermark(store: Store, body: unknown): number {
  if (typeof body !== "object" || body === null)
    return decisionWatermark(store);
  const value = (body as Record<string, unknown>).expectedWatermark;
  if (value === undefined) return decisionWatermark(store);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new AppError(
    "INVALID_INPUT",
    "expectedWatermark must be a non-negative integer.",
    400,
  );
}

/**
 * Review items and decision append routes. Decisions are validated against the
 * Task 6 schemas; stale or conflicting appends surface as 409 and duplicate
 * client request ids return the original decision.
 */
export async function registerReviewRoutes(
  app: FastifyInstance,
  store: Store,
): Promise<void> {
  app.get("/api/review", async (request) => {
    const params = parsePageParams(request.query);
    const sort = parseSortSpec(
      request.query,
      ["key", "code", "severity"],
      "key",
    );
    const active = activeProjection(store);
    const issues = active.projection?.issues ?? [];
    const all = sortWithAllowlist(issues, sort, {
      key: (entry) => entry.key,
      code: (entry) => entry.code,
      severity: (entry) => entry.severity,
    });
    return toEnvelope(
      pageSlice(all, params),
      params,
      all.length,
      active.buildId,
      active.stale,
    );
  });

  app.post("/api/decisions", async (request, reply) => {
    const expected = readExpectedWatermark(store, request.body);
    try {
      const decision = await appendDecision(store, request.body, expected);
      reply.code(201);
      return { decision };
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "STALE_INPUT" || error.code === "ALLOCATION_CONFLICT")
      ) {
        throw new AppError(error.code, error.message, 409);
      }
      throw error;
    }
  });
}

import type { FastifyInstance } from "fastify";
import { pageSlice, parsePageParams, toEnvelope } from "../../shared/api.js";
import { AppError } from "../../shared/errors.js";
import {
  acceptProposal,
  decisionWatermark,
  rejectProposal,
} from "../ai/proposals.js";
import { listRunSummaries, readRun } from "../ai/runs.js";
import type { Store } from "../storage/database.js";

function readString(value: unknown, name: string, fallback?: string): string {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new AppError("INVALID_INPUT", `${name} is required.`, 400);
  }
  if (typeof value !== "string" || value === "") {
    throw new AppError(
      "INVALID_INPUT",
      `${name} must be a non-empty string.`,
      400,
    );
  }
  return value;
}

function readWatermark(store: Store, body: unknown): number {
  if (body === null || typeof body !== "object")
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

/** Proposal runs: list, read, accept and reject. Runs are created by chat. */
export async function registerAnalysisRoutes(
  app: FastifyInstance,
  store: Store,
): Promise<void> {
  app.get("/api/analysis", async (request) => {
    const params = parsePageParams(request.query);
    const all = listRunSummaries(store);
    return toEnvelope(pageSlice(all, params), params, all.length, null, false);
  });

  app.get("/api/analysis/:id", async (request) => {
    const { id } = request.params as { id: string };
    const run = readRun(store, id);
    if (run === null) {
      throw new AppError(
        "RUN_NOT_FOUND",
        `No analysis run exists for id ${id}.`,
        404,
      );
    }
    return { run };
  });

  app.post("/api/analysis/:id/accept", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const proposalId = readString(body.proposalId, "proposalId");
    const expectedWatermark = readWatermark(store, request.body);
    try {
      const decisions = await acceptProposal(
        store,
        id,
        proposalId,
        expectedWatermark,
        body.clientRequestId === undefined
          ? undefined
          : readString(body.clientRequestId, "clientRequestId"),
      );
      return { decisions };
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "STALE_INPUT" ||
          error.code === "ALLOCATION_CONFLICT" ||
          error.code === "PROPOSAL_INVALID")
      ) {
        throw new AppError(error.code, error.message, 409);
      }
      throw error;
    }
  });

  app.post("/api/analysis/:id/reject", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason =
      body.reason === undefined ? undefined : readString(body.reason, "reason");
    const expectedWatermark = readWatermark(store, request.body);
    try {
      const decision = await rejectProposal(
        store,
        id,
        reason,
        expectedWatermark,
      );
      return { decision };
    } catch (error) {
      if (error instanceof AppError && error.code === "STALE_INPUT") {
        throw new AppError(error.code, error.message, 409);
      }
      throw error;
    }
  });
}

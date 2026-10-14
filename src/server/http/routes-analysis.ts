import type { FastifyInstance } from "fastify";
import { AppError } from "../../shared/errors.js";
import {
  type AnalysisEvent,
  answerAnalysis,
  readAnalysisRun,
  startAnalysis,
  subscribeAnalysis,
} from "../ai/analysis.js";
import { defaultProfileId } from "../ai/profiles.js";
import {
  acceptProposal,
  decisionWatermark,
  rejectProposal,
} from "../ai/proposals.js";
import { activeProjection } from "../builds/service.js";
import type { Store } from "../storage/database.js";

const TERMINAL = new Set(["proposal_ready", "failed", "cancelled", "accepted"]);

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

function readIssueKeys(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new AppError(
      "INVALID_INPUT",
      "issueKeys must be an array of strings.",
      400,
    );
  }
  return value as string[];
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

function sseFrame(event: AnalysisEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Analysis routes. Starting a run is a same-origin mutation like every other;
 * acceptance and rejection append retained decisions only after the run is
 * re-validated against the current ledger. The event stream carries question
 * requests so a person can answer a blocked turn.
 */
export async function registerAnalysisRoutes(
  app: FastifyInstance,
  store: Store,
): Promise<void> {
  app.post("/api/analysis", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const profileId = readString(
      body.profileId,
      "profileId",
      defaultProfileId(store) ?? undefined,
    );
    const active = activeProjection(store);
    const buildId = readString(
      body.buildId,
      "buildId",
      active.buildId ?? undefined,
    );
    const runId = await startAnalysis(
      store,
      {
        profileId,
        buildId,
        issueKeys: readIssueKeys(body.issueKeys),
        cloudConfirmed: body.cloudConfirmed === true,
      },
      new AbortController().signal,
    );
    reply.code(202);
    return { runId };
  });

  app.get("/api/analysis/:id", async (request) => {
    const { id } = request.params as { id: string };
    const run = readAnalysisRun(store, id);
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

  app.post("/api/analysis/:id/answer", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const requestId = readString(body.requestId, "requestId");
    const text = readString(body.text, "text");
    const status = answerAnalysis(id, requestId, text);
    return { status };
  });

  app.get("/api/analysis/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = readAnalysisRun(store, id);
    if (run === null) {
      throw new AppError(
        "RUN_NOT_FOUND",
        `No analysis run exists for id ${id}.`,
        404,
      );
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    // A run that already finished (for example after a restart, when its
    // in-memory event buffer is gone) still reports its terminal status and
    // closes, so the stream never hangs.
    if (TERMINAL.has(run.status)) {
      reply.raw.write(
        sseFrame({ type: "status", status: run.status } as AnalysisEvent),
      );
      reply.raw.end();
      return;
    }
    let closed = false;
    const unsubscribe = subscribeAnalysis(id, (event) => {
      if (closed) return;
      reply.raw.write(sseFrame(event));
      if (event.type === "status" && TERMINAL.has(event.status)) {
        closed = true;
        unsubscribe();
        reply.raw.end();
      }
    });
    request.raw.on("close", () => {
      closed = true;
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    });
  });
}

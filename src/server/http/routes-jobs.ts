import type { FastifyInstance } from "fastify";
import { AppError } from "../../shared/errors.js";
import {
  ALGORITHM_VERSION,
  activeBuildMeta,
  type BuildScheduler,
  rollbackBuild,
} from "../builds/service.js";
import type { JobService } from "../jobs/service.js";
import { LEDGER_PARSER_VERSION } from "../ledger/normalize.js";
import type { Store } from "../storage/database.js";
import { registerJobEvents } from "./events.js";

function readMode(body: unknown): "full" | "projection" {
  if (typeof body !== "object" || body === null) {
    throw new AppError("INVALID_INPUT", "A build mode is required.", 400);
  }
  const mode = (body as Record<string, unknown>).mode;
  if (mode === "full" || mode === "projection") return mode;
  throw new AppError(
    "INVALID_INPUT",
    "mode must be either full or projection.",
    400,
  );
}

/**
 * Build, rollback and job routes. Builds are submitted to the coalescing
 * scheduler, which persists a job and returns its id immediately; clients poll
 * the job or open its SSE stream for progress.
 */
export async function registerJobRoutes(
  app: FastifyInstance,
  store: Store,
  jobs: JobService,
  scheduler: BuildScheduler,
): Promise<void> {
  app.post("/api/builds", async (request, reply) => {
    const mode = readMode(request.body);
    const jobId = await scheduler.submit({
      mode,
      parserVersion: LEDGER_PARSER_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    reply.code(202);
    return { jobId };
  });

  app.post("/api/builds/:id/rollback", async (request) => {
    const { id } = request.params as { id: string };
    await rollbackBuild(store, id);
    const meta = activeBuildMeta(store);
    return { buildId: meta.buildId, stale: meta.stale };
  });

  app.get("/api/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const job = jobs.read(id);
    if (job === null) {
      throw new AppError("JOB_NOT_FOUND", `No job exists for id ${id}.`, 404);
    }
    return { job };
  });

  app.post("/api/jobs/:id/cancel", async (request) => {
    const { id } = request.params as { id: string };
    const job = await jobs.cancel(id);
    return { job };
  });

  registerJobEvents(app, jobs);
}

import type { FastifyInstance } from "fastify";
import {
  isTerminalJobStatus,
  type JobRecord,
  type JobService,
} from "../jobs/service.js";

const POLL_INTERVAL_MS = 50;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Server-sent-events stream for one job. It is a GET, emits the persisted
 * status first, then a terminal event, and closes. A browser that reconnects
 * (or falls back to `GET /api/jobs/:id`) observes the same persisted state.
 */
export function registerJobEvents(
  app: FastifyInstance,
  jobs: JobService,
): void {
  app.get("/api/jobs/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const initial = jobs.read(id);
    if (initial === null) {
      reply.code(404);
      return { code: "JOB_NOT_FOUND", message: `No job exists for id ${id}.` };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const send = (event: string, job: JobRecord): void => {
      reply.raw.write(sseFrame(event, job));
    };
    send("status", initial);
    if (isTerminalJobStatus(initial.status)) {
      send("terminal", initial);
      reply.raw.end();
      return;
    }

    const interval = setInterval(() => {
      const current = jobs.read(id);
      if (current === null) {
        clearInterval(interval);
        reply.raw.end();
        return;
      }
      if (isTerminalJobStatus(current.status)) {
        send("terminal", current);
        clearInterval(interval);
        reply.raw.end();
      }
    }, POLL_INTERVAL_MS);
    request.raw.on("close", () => clearInterval(interval));
  });
}

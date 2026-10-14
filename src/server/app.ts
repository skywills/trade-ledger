import multipart from "@fastify/multipart";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { ApiErrorBody } from "../shared/api.js";
import { AppError } from "../shared/errors.js";
import { BuildScheduler, type BuildServiceOptions } from "./builds/service.js";
import type { AppConfig } from "./config.js";
import { createOriginGuard } from "./http/origin.js";
import { registerImportRoutes } from "./http/routes-imports.js";
import { registerJobRoutes } from "./http/routes-jobs.js";
import { registerJournalRoutes } from "./http/routes-journal.js";
import { registerReviewRoutes } from "./http/routes-review.js";
import { JobService } from "./jobs/service.js";
import { checkDataAccess, closeStore, openStore } from "./storage/database.js";

export interface AppOptions {
  /** Test seam forwarded to the build scheduler (faults, clock). */
  buildOptions?: BuildServiceOptions;
}

interface MappedError {
  statusCode: number;
  body: ApiErrorBody;
}

function mapError(error: unknown): MappedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: { code: error.code, message: error.message },
    };
  }
  const flagged = error as {
    code?: string;
    statusCode?: number;
    message?: string;
    validation?: unknown;
  };
  if (flagged.code === "FST_REQ_FILE_TOO_LARGE") {
    return {
      statusCode: 413,
      body: {
        code: "IMPORT_TOO_LARGE",
        message: "The uploaded file exceeds the configured upload limit.",
      },
    };
  }
  if (
    flagged.validation !== undefined ||
    flagged.code === "FST_ERR_VALIDATION" ||
    flagged.code === "FST_ERR_CTP_EMPTY_JSON_BODY"
  ) {
    return {
      statusCode: 400,
      body: {
        code: "INVALID_INPUT",
        message: "Request body failed validation.",
        ...(flagged.validation === undefined
          ? {}
          : { issues: flagged.validation }),
      },
    };
  }
  if (flagged.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return {
      statusCode: 415,
      body: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Unsupported content type.",
      },
    };
  }
  const statusCode = flagged.statusCode ?? 500;
  if (statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      body: {
        code: flagged.code ?? "INVALID_INPUT",
        message: flagged.message ?? "Request rejected.",
      },
    };
  }
  return {
    statusCode: 500,
    body: { code: "INTERNAL_ERROR", message: "Internal server error." },
  };
}

function sendError(reply: FastifyReply, mapped: MappedError): void {
  reply.code(mapped.statusCode).send(mapped.body);
}

/**
 * Composes the storage store, the shared job service, the coalescing build
 * scheduler and every HTTP route. Listening is the caller's responsibility so
 * tests can drive the app with `inject`.
 */
export async function createApp(
  config: AppConfig,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const store = openStore(config.dataDir);
  try {
    const jobs = new JobService(store);
    const scheduler = new BuildScheduler(
      store,
      options.buildOptions ?? {},
      jobs,
    );

    app.addHook("onClose", async () => {
      await closeStore(store);
    });
    app.addHook("onRequest", createOriginGuard(config.allowedOrigin));
    app.setErrorHandler(
      (error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
        sendError(reply, mapError(error));
      },
    );
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      reply.code(404).send({
        code: "NOT_FOUND",
        message: `No route for ${request.method} ${request.url}.`,
      } satisfies ApiErrorBody);
    });

    await app.register(multipart, {
      limits: { fileSize: config.uploadLimitBytes, files: 20, fields: 20 },
    });
    // The API accepts JSON (and multipart for imports) only; drop Fastify's
    // default text/plain parser so stray bodies fail with a uniform 415.
    app.removeContentTypeParser("text/plain");

    app.get("/health/live", async () => ({ status: "ok" }));
    app.get("/health/ready", async (_request, reply) => {
      if (!checkDataAccess(store)) {
        reply.code(503);
        return { status: "unready" };
      }
      return { status: "ok" };
    });

    await registerImportRoutes(app, store);
    await registerJournalRoutes(app, store);
    await registerReviewRoutes(app, store);
    await registerJobRoutes(app, store, jobs, scheduler);

    return app;
  } catch (error) {
    await closeStore(store);
    throw error;
  }
}

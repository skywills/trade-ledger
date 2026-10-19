import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { ApiErrorBody } from "../shared/api.js";
import { AppError } from "../shared/errors.js";
import { createSecretResolver } from "./ai/credentials.js";
import {
  BuildScheduler,
  type BuildServiceOptions,
  recoverBuilds,
} from "./builds/service.js";
import { ChatService } from "./chat/service.js";
import { recoverChatThreads } from "./chat/threads.js";
import type { AppConfig } from "./config.js";
import { createHostGuard, createOriginGuard } from "./http/origin.js";
import { registerAnalysisRoutes } from "./http/routes-analysis.js";
import { registerAnalyticsRoutes } from "./http/routes-analytics.js";
import { registerChatRoutes } from "./http/routes-chat.js";
import { registerImportRoutes } from "./http/routes-imports.js";
import { registerJobRoutes } from "./http/routes-jobs.js";
import { registerJournalRoutes } from "./http/routes-journal.js";
import { registerLifecycleRoutes } from "./http/routes-lifecycles.js";
import { registerMaintenanceRoutes } from "./http/routes-maintenance.js";
import { registerModelRoutes } from "./http/routes-models.js";
import { registerReviewRoutes } from "./http/routes-review.js";
import { recoverImportFiles } from "./imports/service.js";
import { JobService } from "./jobs/service.js";
import {
  acquireDataDirLock,
  assertNoIncompleteRestore,
} from "./maintenance/lock.js";
import { registerJournalReset } from "./maintenance/reset.js";
import {
  checkDataAccess,
  closeStore,
  openStore,
  type Store,
} from "./storage/database.js";

/** The composed server components exposed to the process entry point. */
export interface AppContext {
  readonly store: Store;
  readonly jobs: JobService;
  readonly scheduler: BuildScheduler;
  readonly chat: ChatService;
}

export interface AppOptions {
  /** Test seam forwarded to the build scheduler (faults, clock). */
  buildOptions?: BuildServiceOptions;
  /** Called once the store and services are composed, before listening. */
  onReady?: (context: AppContext) => void;
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
 * True only for GET paths that belong to the single-page frontend: not an
 * `/api/*` route and with no file extension on the last segment. Missing
 * assets (which have extensions) and unknown API routes stay 404s so the SPA
 * fallback can never mask an API error as HTML.
 */
function isFrontendPath(method: string, rawUrl: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return false;
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return lastSegment === "" || !lastSegment.includes(".");
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
  // The single-process data-directory lock is held for the life of the server
  // so the backup/restore CLI can never race a live writer.
  const lock = acquireDataDirLock(config.dataDir);
  let store: Store;
  try {
    assertNoIncompleteRestore(config.dataDir);
    store = openStore(config.dataDir);
  } catch (error) {
    lock.release();
    throw error;
  }
  try {
    // Startup recovery runs once here, before any request is served: builds
    // left non-terminal by a dead process are failed so they can never be
    // rolled back, and orphaned import staging bytes are reclaimed. Both are
    // idempotent and safe on a fresh store.
    await recoverBuilds(store);
    await recoverImportFiles(store);
    await recoverChatThreads(store, new Date());

    const jobs = new JobService(store);
    const scheduler = new BuildScheduler(
      store,
      options.buildOptions ?? {},
      jobs,
    );

    const secrets = createSecretResolver({
      env: process.env,
      allowedFileRoots:
        config.secretsDir === undefined ? [] : [config.secretsDir],
    });

    const chat = new ChatService({ store, secrets, scheduler, jobs });
    const sweep = setInterval(() => {
      chat.sweepIdle().catch(() => undefined);
    }, 60_000);
    sweep.unref();

    app.addHook("onClose", async () => {
      clearInterval(sweep);
      await chat.close();
      await closeStore(store);
      lock.release();
    });
    // Host first: a DNS-rebinding request is refused before anything else.
    app.addHook("onRequest", createHostGuard(config.allowedHosts));
    app.addHook("onRequest", createOriginGuard(config.allowedOrigin));
    app.setErrorHandler(
      (error: unknown, _request: FastifyRequest, reply: FastifyReply) => {
        sendError(reply, mapError(error));
      },
    );
    app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
      if (
        config.staticDir !== undefined &&
        isFrontendPath(request.method, request.url) &&
        // Only a real bundle serves the SPA. A missing index.html must stay a
        // JSON 404 rather than a 500 from sendFile.
        existsSync(join(resolve(config.staticDir), "index.html"))
      ) {
        reply.type("text/html; charset=utf-8");
        return reply.sendFile("index.html");
      }
      reply.code(404).send({
        code: "NOT_FOUND",
        message: `No route for ${request.method} ${request.url}.`,
      } satisfies ApiErrorBody);
    });

    await app.register(multipart, {
      limits: { fileSize: config.uploadLimitBytes, files: 20, fields: 20 },
    });
    if (config.staticDir !== undefined) {
      // Exact-file routes only; the SPA fallback above owns every other
      // frontend path and unknown `/api/*` stays a JSON 404.
      await app.register(fastifyStatic, {
        root: resolve(config.staticDir),
        wildcard: false,
        index: false,
      });
    }
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

    registerJournalReset(app, store, jobs, scheduler, chat);
    await registerImportRoutes(app, store, config.uploadLimitBytes);
    await registerJournalRoutes(app, store);
    await registerAnalyticsRoutes(app, store);
    await registerLifecycleRoutes(app, store);
    await registerReviewRoutes(app, store);
    await registerJobRoutes(app, store, jobs, scheduler);
    await registerModelRoutes(app, store, secrets);
    await registerAnalysisRoutes(app, store);
    await registerMaintenanceRoutes(app, store, jobs);
    await registerChatRoutes(app, store, chat);

    options.onReady?.({ store, jobs, scheduler, chat });

    return app;
  } catch (error) {
    await closeStore(store);
    lock.release();
    throw error;
  }
}

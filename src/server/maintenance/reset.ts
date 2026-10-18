import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  ResetJournalBodySchema,
  ResetPreviewSchema,
} from "../../shared/api.js";
import { AppError } from "../../shared/errors.js";
import type { BuildScheduler } from "../builds/service.js";
import type { ChatService } from "../chat/service.js";
import type { JobService } from "../jobs/service.js";
import { type Store, write } from "../storage/database.js";

const RESET_PATH = "/api/maintenance/reset";

function busyError(): AppError {
  return new AppError(
    "JOURNAL_BUSY",
    "Wait for uploads, model checks, replies and background jobs to finish before resetting.",
    409,
  );
}

/** Install before routes: reserve reset admission before any asynchronous work. */
export function registerJournalReset(
  app: FastifyInstance,
  store: Store,
  jobs: JobService,
  scheduler: BuildScheduler,
  chat: ChatService,
): void {
  const mutations = new Set<string>();
  let resetting = false;
  app.addHook("onRequest", async (request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (resetting) throw busyError();
    mutations.add(request.id);
  });
  // A client can disconnect after its full body arrives. In that case neither
  // onRequestAbort nor onResponse runs; release admission when its handler
  // settles, including error responses, rather than on socket closure.
  app.addHook("onSend", async (request, _reply, payload) => {
    mutations.delete(request.id);
    return payload;
  });
  app.addHook("onError", async (request) => {
    mutations.delete(request.id);
  });
  app.addHook("onResponse", async (request) => {
    mutations.delete(request.id);
  });
  app.addHook("onRequestAbort", async (request) => {
    mutations.delete(request.id);
  });

  app.get(RESET_PATH, async () => {
    const count = (table: string) =>
      (
        store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n;
    return ResetPreviewSchema.parse({
      imports: count("imports"),
      conversations: count("chat_threads"),
      decisions: count("decisions"),
      builds: count("builds"),
    });
  });

  app.post(RESET_PATH, async (request) => {
    if (!ResetJournalBodySchema.safeParse(request.body).success) {
      throw new AppError(
        "INVALID_INPUT",
        "Type RESET to confirm journal deletion.",
        400,
      );
    }
    if (
      mutations.size !== 1 ||
      !mutations.has(request.id) ||
      jobs.hasActiveWork() ||
      scheduler.hasActiveWork() ||
      chat.hasActiveWork()
    )
      throw busyError();
    // Persisted state also covers work admitted just before its controller is registered.
    if (
      store.db
        .prepare(
          "SELECT 1 FROM jobs WHERE status = 'running' UNION ALL SELECT 1 FROM chat_threads WHERE status IN ('running', 'waiting') LIMIT 1",
        )
        .get() !== undefined
    )
      throw busyError();
    resetting = true;
    try {
      // Close idle hosted sessions so they cannot retain deleted conversation context.
      await chat.close();
      await write(store, () => {
        store.db
          .prepare(
            "UPDATE app_state SET active_build_id = NULL, updated_at = ?",
          )
          .run(new Date().toISOString());
        // Dependency order keeps foreign-key enforcement enabled throughout reset.
        for (const table of [
          "ai_runs",
          "chat_threads",
          "lifecycle_projection_views",
          "lifecycle_identities",
          "campaign_identities",
          "strategy_links",
          "position_views",
          "strategy_allocations",
          "strategy_views",
          "review_items",
          "builds",
          "identity_bindings",
        ])
          store.db.exec(`DELETE FROM ${table}`);
        store.db.exec("UPDATE decisions SET supersedes_id = NULL");
        for (const table of [
          "decisions",
          "strategy_identities",
          "transaction_sources",
          "lot_details",
          "ledger_issues",
          "transaction_revisions",
          "ledger_builds",
          "import_rows",
          "imports",
          "import_previews",
          "accounts",
          "jobs",
        ])
          store.db.exec(`DELETE FROM ${table}`);
      });
      try {
        rmSync(store.sourceRoot, { recursive: true, force: true });
        mkdirSync(store.sourceRoot, { recursive: true });
        rmSync(join(store.dataDir, "transcripts"), {
          recursive: true,
          force: true,
        });
      } catch {
        throw new AppError(
          "RESET_FILES_PENDING",
          "Journal records were cleared, but file cleanup failed. Check data-directory permissions and retry reset to finish cleanup.",
          500,
        );
      }
      return { reset: true };
    } finally {
      resetting = false;
    }
  });
}

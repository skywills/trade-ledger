import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { AppError } from "../../shared/errors.js";
import type { JobService } from "../jobs/service.js";
import { createBackup } from "../maintenance/backup.js";
import type { Store } from "../storage/database.js";

const RESTORE_INSTRUCTIONS = [
  "Stop the journal instance so no process holds the data-directory lock.",
  "Run: npm run restore -- --archive <backup.tar> --data-dir <data-dir>",
  "The restore validates checksums and schema versions and makes a pre-restore backup before swapping.",
  "Start the journal again and reconfigure any credentials; secrets are never stored in a backup.",
];

/**
 * Online maintenance routes. A backup runs as a persisted job the browser can
 * watch and then download; restore is deliberately offline-only and this API
 * never performs one. Mutations are covered by the shared same-origin guard.
 */
export async function registerMaintenanceRoutes(
  app: FastifyInstance,
  store: Store,
  jobs: JobService,
): Promise<void> {
  const backupsDir = join(store.dataDir, "backups");

  app.post("/api/maintenance/backups", async (_request, reply) => {
    const jobId = await jobs.create("backup", {
      requestedAt: new Date().toISOString(),
    });
    const controller = new AbortController();
    jobs.register(jobId, controller);
    void (async () => {
      try {
        await jobs.progress(jobId, "snapshotting");
        mkdirSync(backupsDir, { recursive: true });
        const outputPath = join(backupsDir, `${jobId}.tar`);
        await createBackup(store, outputPath, { signal: controller.signal });
        // Never overwrite a status a concurrent cancel already recorded.
        await jobs.finishIfRunning(jobId, "complete");
      } catch (error) {
        await jobs.finishIfRunning(
          jobId,
          controller.signal.aborted ? "cancelled" : "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
    reply.code(202);
    return { jobId };
  });

  app.get("/api/maintenance/backups/:id/download", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!/^[0-9a-fA-F-]{1,64}$/.test(id)) {
      throw new AppError("BACKUP_NOT_FOUND", "No such backup.", 404);
    }
    const filePath = join(backupsDir, `${id}.tar`);
    if (!existsSync(filePath)) {
      throw new AppError("BACKUP_NOT_FOUND", "No such backup.", 404);
    }
    reply.header("content-type", "application/octet-stream");
    reply.header(
      "content-disposition",
      `attachment; filename="journal-backup-${id}.tar"`,
    );
    return reply.send(createReadStream(filePath));
  });

  app.get("/api/maintenance/restore", async () => ({
    offline: true,
    instructions: RESTORE_INSTRUCTIONS,
  }));
}

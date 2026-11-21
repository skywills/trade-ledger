import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { AppError } from "../../shared/errors.js";
import type { JobService } from "../jobs/service.js";
import { startBackupJob } from "../maintenance/backup-job.js";
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

  app.get("/api/maintenance/builds", async () => ({
    builds: store.db
      .prepare(`
      SELECT b.id, b.created_at AS createdAt, b.status,
             CASE WHEN b.id = s.active_build_id THEN 1 ELSE 0 END AS active
      FROM builds b CROSS JOIN app_state s
      WHERE s.singleton = 1 AND b.status IN ('active', 'stale')
      ORDER BY b.created_at DESC, b.rowid DESC
    `)
      .all(),
  }));

  app.get("/api/maintenance/backups", async () => {
    const latestRow = store.db
      .prepare(
        "SELECT id FROM jobs WHERE kind = 'backup' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as { id: string } | undefined;
    const latest = latestRow ? jobs.read(latestRow.id) : null;
    const files = existsSync(backupsDir)
      ? await readdir(backupsDir, { withFileTypes: true })
      : [];
    const archives = [];
    for (const file of files) {
      if (!file.isFile() || !/^[0-9a-fA-F-]{1,64}\.tar$/.test(file.name))
        continue;
      const id = file.name.slice(0, -4);
      const job = jobs.read(id);
      // Reset retains archives even when it clears their old job records.
      if (job && job.status !== "complete") continue;
      const createdAt =
        job?.finishedAt ??
        (await stat(join(backupsDir, file.name))).mtime.toISOString();
      archives.push({ id, createdAt });
    }
    archives.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      latest,
      archives: archives.slice(0, 20),
    };
  });

  app.post("/api/maintenance/backups", async (_request, reply) => {
    const jobId = await startBackupJob(store, jobs);
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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Id } from "../../shared/domain.js";
import type { JobService } from "../jobs/service.js";
import type { Store } from "../storage/database.js";
import { createBackup } from "./backup.js";

/** Starts a backup as a background job; resolves with the job id at once. */
export async function startBackupJob(
  store: Store,
  jobs: JobService,
): Promise<Id> {
  const backupsDir = join(store.dataDir, "backups");
  const jobId = await jobs.create("backup", {
    requestedAt: new Date().toISOString(),
  });
  const controller = new AbortController();
  jobs.register(jobId, controller);
  void (async () => {
    try {
      await jobs.progress(jobId, "snapshotting");
      mkdirSync(backupsDir, { recursive: true });
      await createBackup(store, join(backupsDir, `${jobId}.tar`), {
        signal: controller.signal,
      });
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
  return jobId;
}

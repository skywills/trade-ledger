import { describe, expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  BuildScheduler,
  type RebuildInput,
} from "../../src/server/builds/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { JobService } from "../../src/server/jobs/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import { AppError } from "../../src/shared/errors.js";
import { fixtures } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

const input = (): RebuildInput => ({
  mode: "full",
  parserVersion: LEDGER_PARSER_VERSION,
  algorithmVersion: ALGORITHM_VERSION,
  signal: new AbortController().signal,
});

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const env = await createTestStore();
  try {
    await run(env.store);
  } finally {
    await env.dispose();
  }
}

function lastJob(store: Store) {
  return store.db
    .prepare(
      "SELECT id, status, progress, error, finished_at FROM jobs ORDER BY rowid DESC LIMIT 1",
    )
    .get() as {
    id: string;
    status: string;
    progress: string;
    error: string | null;
    finished_at: string | null;
  };
}

describe("rebuild job lifecycle", () => {
  it("finishes the job when changed inputs leave a retained stale candidate", async () =>
    withStore(async (store) => {
      const jobs = new JobService(store);
      const scheduler = new BuildScheduler(
        store,
        {
          faults: {
            afterCompute: async () => {
              const preview = await previewImport(store, {
                filename: "arrived-during-build.csv",
                bytes: fixtures.spread,
                timezone: "UTC",
              });
              await commitImport(store, preview.id);
            },
          },
        },
        jobs,
      );
      const result = await scheduler.request(input());
      expect(result.status).toBe("stale");
      expect(activeProjection(store).buildId).toBeNull();
      expect(
        store.db
          .prepare("SELECT status FROM builds WHERE id = ?")
          .get(result.id),
      ).toEqual({ status: "stale" });
      expect(lastJob(store)).toMatchObject({
        status: "complete",
        progress: "complete",
      });
      expect(jobs.hasActiveWork()).toBe(false);
    }));

  it("preserves cancellation recorded between activation and job completion", async () =>
    withStore(async (store) => {
      const jobs = new JobService(store);
      const scheduler = new BuildScheduler(store, {}, jobs);
      // Commit the competing cancellation in the activation transaction, before
      // the scheduler can enqueue its completion write. No timing assumption.
      store.db.exec(`
        CREATE TRIGGER cancel_at_activation AFTER UPDATE OF active_build_id ON app_state
        BEGIN
          UPDATE jobs SET status = 'cancelled', progress = 'cancelled',
            finished_at = '2026-10-19T00:00:00.000Z' WHERE status = 'running';
        END;
      `);
      const result = await scheduler.request(input());
      expect(result.status).toBe("active");
      expect(activeProjection(store).buildId).toBe(result.id);
      expect(lastJob(store)).toMatchObject({
        status: "cancelled",
        progress: "cancelled",
        finished_at: "2026-10-19T00:00:00.000Z",
      });
      expect(jobs.hasActiveWork()).toBe(false);
      expect(scheduler.hasActiveWork()).toBe(false);
    }));

  it("fails and releases a job when progress persistence fails, then accepts another rebuild", async () =>
    withStore(async (store) => {
      const jobs = new JobService(store);
      const scheduler = new BuildScheduler(store, {}, jobs);
      store.db.exec(`
        CREATE TRIGGER reject_computing BEFORE UPDATE OF progress ON jobs
        WHEN NEW.progress = 'computing'
        BEGIN SELECT RAISE(ABORT, 'progress persistence failed'); END;
      `);
      await expect(scheduler.request(input())).rejects.toThrow(
        "progress persistence failed",
      );
      expect(lastJob(store)).toMatchObject({
        status: "failed",
        progress: "failed",
      });
      expect(lastJob(store).finished_at).not.toBeNull();
      expect(jobs.hasActiveWork()).toBe(false);
      expect(scheduler.hasActiveWork()).toBe(false);
      expect(activeProjection(store).buildId).toBeNull();

      store.db.exec("DROP TRIGGER reject_computing");
      await expect(scheduler.request(input())).resolves.toMatchObject({
        status: "active",
      });
      expect(lastJob(store).status).toBe("complete");
      expect(jobs.hasActiveWork()).toBe(false);
    }));

  it("surfaces the original build error when persisting the failed job also fails", async () =>
    withStore(async (store) => {
      const jobs = new JobService(store);
      const original = new AppError(
        "BUILD_EXPLODED",
        "original build failure",
        500,
      );
      const scheduler = new BuildScheduler(
        store,
        {
          faults: {
            afterCompute: () => {
              throw original;
            },
          },
        },
        jobs,
      );
      store.db.exec(`
        CREATE TRIGGER reject_failed_job BEFORE UPDATE OF status ON jobs
        WHEN NEW.status = 'failed'
        BEGIN SELECT RAISE(ABORT, 'failure reporting failed'); END;
      `);
      await expect(scheduler.request(input())).rejects.toBe(original);
      expect(jobs.hasActiveWork()).toBe(false);
      expect(scheduler.hasActiveWork()).toBe(false);
      expect(activeProjection(store).buildId).toBeNull();
      expect(store.db.prepare("SELECT status FROM builds").get()).toEqual({
        status: "failed",
      });
      // A failed database write leaves persisted recovery to the next startup,
      // but must never leave the in-process active-work registry occupied.
      expect(lastJob(store).status).toBe("running");
    }));

  it("records failure and releases the job when validation fails before a candidate exists", async () =>
    withStore(async (store) => {
      const jobs = new JobService(store);
      const scheduler = new BuildScheduler(store, {}, jobs);
      await expect(
        scheduler.request({ ...input(), parserVersion: "unavailable" }),
      ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
      expect(lastJob(store).status).toBe("failed");
      expect(jobs.hasActiveWork()).toBe(false);
      expect(
        store.db.prepare("SELECT count(*) AS count FROM builds").get(),
      ).toEqual({ count: 0 });
    }));

  it("keeps cancelled progress terminal when an already queued progress update runs", async () =>
    withStore(async (store) => {
      const jobs = new JobService(store);
      const id = await jobs.create("rebuild", {});
      jobs.register(id, new AbortController());
      const cancelling = jobs.cancel(id);
      const progress = jobs.progress(id, "computing");
      await cancelling;
      await progress;
      expect(jobs.read(id)).toMatchObject({
        status: "cancelled",
        progress: "cancelled",
      });
      await jobs.finishIfRunning(id, "complete");
      expect(jobs.hasActiveWork()).toBe(false);
    }));
});

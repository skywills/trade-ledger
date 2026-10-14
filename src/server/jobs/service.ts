import { randomUUID } from "node:crypto";
import type { Id } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import { type Store, write } from "../storage/database.js";

export const TERMINAL_JOB_STATUSES = [
  "complete",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export function isTerminalJobStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

export interface JobRecord {
  id: Id;
  kind: string;
  status: string;
  progress: string | null;
  error: string | null;
  input: unknown;
  createdAt: string;
  finishedAt: string | null;
}

interface JobRow {
  id: string;
  kind: string;
  input_snapshot: string;
  status: string;
  progress: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

function toRecord(row: JobRow): JobRecord {
  let input: unknown = null;
  try {
    input = JSON.parse(row.input_snapshot);
  } catch {
    input = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    error: row.error,
    input,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Owns the persisted `jobs` table. Long operations create a running row,
 * publish progress, and finish it; the HTTP layer only reads. Abort controllers
 * are registered per job so a cancel request stops the in-flight work before it
 * can activate a partial result.
 */
export class JobService {
  private readonly controllers = new Map<Id, AbortController>();

  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(kind: string, inputSnapshot: unknown): Promise<Id> {
    return write(this.store, () => {
      const id = randomUUID();
      this.store.db
        .prepare(
          `INSERT INTO jobs (id, kind, input_snapshot, status, progress, created_at)
           VALUES (?, ?, ?, 'running', 'queued', ?)`,
        )
        .run(id, kind, JSON.stringify(inputSnapshot), this.now().toISOString());
      return id;
    });
  }

  register(jobId: Id, controller: AbortController): void {
    this.controllers.set(jobId, controller);
  }

  progress(jobId: Id, progress: string): Promise<void> {
    return write(this.store, () => {
      this.store.db
        .prepare("UPDATE jobs SET progress = ? WHERE id = ?")
        .run(progress, jobId);
    });
  }

  finish(jobId: Id, status: string, error?: string): Promise<void> {
    this.controllers.delete(jobId);
    return write(this.store, () => {
      this.store.db
        .prepare(
          `UPDATE jobs
           SET status = ?, progress = ?, finished_at = ?, error = ?
           WHERE id = ?`,
        )
        .run(status, status, this.now().toISOString(), error ?? null, jobId);
    });
  }

  /**
   * Finishes a job only while it is still `running`, returning whether it did.
   * A job cancelled while its work was reaching a terminal state keeps the
   * `cancelled` status instead of being overwritten by a late success.
   */
  finishIfRunning(jobId: Id, status: string, error?: string): Promise<boolean> {
    this.controllers.delete(jobId);
    return write(this.store, () => {
      const result = this.store.db
        .prepare(
          `UPDATE jobs
           SET status = ?, progress = ?, finished_at = ?, error = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(status, status, this.now().toISOString(), error ?? null, jobId);
      return result.changes > 0;
    });
  }

  read(jobId: Id): JobRecord | null {
    const row = this.store.db
      .prepare(
        `SELECT id, kind, input_snapshot, status, progress, error,
                created_at, finished_at
         FROM jobs WHERE id = ?`,
      )
      .get(jobId) as JobRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Aborts an in-flight job and records the terminal cancelled state. A job that
   * already finished is returned untouched so a reconnect observes the persisted
   * status instead of a rewritten one.
   */
  async cancel(jobId: Id): Promise<JobRecord> {
    const current = this.read(jobId);
    if (current === null) {
      throw new AppError(
        "JOB_NOT_FOUND",
        `No job exists for id ${jobId}.`,
        404,
      );
    }
    if (isTerminalJobStatus(current.status)) return current;
    this.controllers.get(jobId)?.abort();
    await write(this.store, () => {
      this.store.db
        .prepare(
          `UPDATE jobs SET status = 'cancelled', progress = 'cancelled',
                  finished_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(this.now().toISOString(), jobId);
    });
    this.controllers.delete(jobId);
    const cancelled = this.read(jobId);
    if (cancelled === null) {
      throw new AppError(
        "JOB_NOT_FOUND",
        `No job exists for id ${jobId}.`,
        404,
      );
    }
    return cancelled;
  }
}

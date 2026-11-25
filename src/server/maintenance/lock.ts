import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppError } from "../../shared/errors.js";

/**
 * Single-process data-directory lock. The online application acquires it at
 * startup and releases it on shutdown; the backup/restore CLI honors it too, so
 * a restore can never race a live writer. The lock records the owning pid so a
 * lock left behind by a crashed process can be recovered once that pid is
 * provably gone.
 */
export const LOCK_FILENAME = "journal.lock";
// Keep the inode across restores and shutdowns. SQLite's OS locks expire when
// the owning connection closes, including when the process is killed.
export const OWNER_DB_FILENAME = ".journal-owner.sqlite";

/**
 * Written by a restore before its entry-by-entry swap and removed once the swap
 * or its rollback completes. If it survives, the process died mid-swap and the
 * data directory may be missing its journal; the previous data is in the
 * `.pre-restore-*` directory the marker names.
 */
export const RESTORE_MARKER_FILENAME = ".restore-in-progress";

/**
 * Refuses to open a data directory whose restore never finished, instead of
 * silently creating an empty journal over the half-swapped contents.
 */
export function assertNoIncompleteRestore(dataDir: string): void {
  const marker = join(dataDir, RESTORE_MARKER_FILENAME);
  if (!existsSync(marker)) return;
  const preRestore = readFileSync(marker, "utf8").trim();
  throw new AppError(
    "RESTORE_INCOMPLETE",
    `A restore into ${dataDir} was interrupted. Move the contents of ${join(dataDir, preRestore)} back into the data directory (or re-run the restore), then delete ${marker}.`,
    500,
  );
}

export interface DataDirLock {
  readonly path: string;
  release(): void;
}

interface LockRecord {
  guarded: boolean;
  pid: number;
  startedAt: string;
  /**
   * The owner's OS start time (Linux `/proc/<pid>/stat` field 22), captured to
   * detect a reused pid. Inside a container the app is always pid 1, so a lock
   * left by an uncleanly killed process would otherwise look "alive" forever.
   * Null when the platform does not expose it.
   */
  pidStart: string | null;
}

/**
 * Reads the Linux process start time for a pid, or null when unavailable (for
 * example on macOS/Windows). Two different processes can never share both a pid
 * and a start time, so a mismatch proves the recorded owner is gone.
 */
function readProcessStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    // Fields after ") " begin at state (field 3); starttime is field 22.
    const fields = stat.slice(close + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as {
      guarded?: unknown;
      pid?: unknown;
      startedAt?: unknown;
      pidStart?: unknown;
    };
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid)) {
      return null;
    }
    return {
      guarded: parsed.guarded === true,
      pid: parsed.pid,
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
      pidStart: typeof parsed.pidStart === "string" ? parsed.pidStart : null,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether the recorded owner is still running. A pid that is alive but whose
 * recorded start time no longer matches the live process has been reused, so
 * the lock is stale and the directory is recoverable.
 */
function lockOwnerIsLive(record: LockRecord): boolean {
  if (!isProcessAlive(record.pid)) return false;
  const actualStart = readProcessStartTime(record.pid);
  if (record.pidStart !== null && actualStart !== null) {
    return record.pidStart === actualStart;
  }
  return true;
}

function isBusy(error: unknown): boolean {
  return error instanceof Database.SqliteError && error.code === "SQLITE_BUSY";
}

/** Reports ownership, including during PID record publication and cleanup. */
export function isDataDirLocked(dataDir: string): boolean {
  const ownerPath = join(dataDir, OWNER_DB_FILENAME);
  if (existsSync(ownerPath)) {
    let probe: Database.Database | undefined;
    try {
      probe = new Database(ownerPath, { readonly: true, timeout: 0 });
      probe.prepare("SELECT COUNT(*) FROM sqlite_schema").get();
    } catch (error) {
      if (isBusy(error)) return true;
      throw error;
    } finally {
      probe?.close();
    }
  }
  const record = readLockRecord(join(dataDir, LOCK_FILENAME));
  return record !== null && !record.guarded && lockOwnerIsLive(record);
}

function writeLock(lockPath: string, record: LockRecord): void {
  const fd = openSync(lockPath, "wx");
  try {
    writeFileSync(fd, JSON.stringify(record));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Take an OS-backed exclusive transaction before inspecting, reclaiming or
 * publishing journal.lock. Keep the PID file for compatibility with existing
 * installations. A guarded record left after transaction acquisition belongs
 * to a previous owner, including when a container reuses its PID.
 */
export function acquireDataDirLock(dataDir: string): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, LOCK_FILENAME);
  const owner = new Database(join(dataDir, OWNER_DB_FILENAME), { timeout: 0 });
  try {
    owner.exec("BEGIN EXCLUSIVE");
    if (existsSync(lockPath)) {
      const previous = readLockRecord(lockPath);
      if (previous && !previous.guarded && lockOwnerIsLive(previous)) {
        throw new AppError(
          "DATA_DIR_LOCKED",
          `The data directory is in use by running process ${previous.pid}. Stop it before continuing.`,
          409,
        );
      }
      unlinkSync(lockPath);
    }
    writeLock(lockPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      pidStart: readProcessStartTime(process.pid),
      guarded: true,
    });
  } catch (error) {
    owner.close();
    if (isBusy(error) || (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AppError(
        "DATA_DIR_LOCKED",
        "The data directory is in use.",
        409,
      );
    }
    throw error;
  }

  return {
    path: lockPath,
    release() {
      if (!owner.open) return;
      try {
        unlinkSync(lockPath);
      } finally {
        owner.close();
      }
    },
  };
}

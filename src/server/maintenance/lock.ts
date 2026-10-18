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
import { AppError } from "../../shared/errors.js";

/**
 * Single-process data-directory lock. The online application acquires it at
 * startup and releases it on shutdown; the backup/restore CLI honors it too, so
 * a restore can never race a live writer. The lock records the owning pid so a
 * lock left behind by a crashed process can be recovered once that pid is
 * provably gone.
 */
export const LOCK_FILENAME = "journal.lock";

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
      pid?: unknown;
      startedAt?: unknown;
      pidStart?: unknown;
    };
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid)) {
      return null;
    }
    return {
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

/**
 * Whether a live process holds the lock. A missing, unreadable or stale lock
 * (its recorded pid is gone) reports false so the directory is recoverable.
 */
export function isDataDirLocked(dataDir: string): boolean {
  const lockPath = join(dataDir, LOCK_FILENAME);
  const record = readLockRecord(lockPath);
  if (record === null) return false;
  return lockOwnerIsLive(record);
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
 * Acquires the exclusive data-directory lock or throws DATA_DIR_LOCKED when a
 * live process already owns it. A stale lock whose pid is no longer alive is
 * removed and re-acquired.
 */
export function acquireDataDirLock(dataDir: string): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, LOCK_FILENAME);
  const record: LockRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    pidStart: readProcessStartTime(process.pid),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeLock(lockPath, record);
      return {
        path: lockPath,
        release() {
          try {
            const current = readLockRecord(lockPath);
            if (current !== null && current.pid !== process.pid) return;
            unlinkSync(lockPath);
          } catch {
            // Releasing a lock that is already gone is a no-op.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = readLockRecord(lockPath);
    if (existing !== null && lockOwnerIsLive(existing)) {
      throw new AppError(
        "DATA_DIR_LOCKED",
        `The data directory is in use by running process ${existing.pid}. Stop it before continuing.`,
        409,
      );
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have already recovered the stale lock.
    }
  }

  throw new AppError(
    "DATA_DIR_LOCKED",
    "Could not acquire the data-directory lock.",
    409,
  );
}

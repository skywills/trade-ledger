import {
  closeSync,
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

export interface DataDirLock {
  readonly path: string;
  release(): void;
}

interface LockRecord {
  pid: number;
  startedAt: string;
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as {
      pid?: unknown;
      startedAt?: unknown;
    };
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid)) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
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
 * Whether a live process holds the lock. A missing, unreadable or stale lock
 * (its recorded pid is gone) reports false so the directory is recoverable.
 */
export function isDataDirLocked(dataDir: string): boolean {
  const lockPath = join(dataDir, LOCK_FILENAME);
  const record = readLockRecord(lockPath);
  if (record === null) return false;
  return isProcessAlive(record.pid);
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
    if (existing !== null && isProcessAlive(existing.pid)) {
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

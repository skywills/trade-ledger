import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppError } from "../../shared/errors.js";

/** Held by the server and offline maintenance commands. Older releases use a
 * file here. A directory prevents their file-only cleanup from removing a live
 * marker, even when they cannot see our process in their PID namespace. */
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

type LockMarker = "missing" | "directory" | "legacy";

function readMarker(lockPath: string): LockMarker {
  const stat = lstatSync(lockPath, { throwIfNoEntry: false });
  if (!stat) return "missing";
  // Even a stale-looking file can be replaced by a PID-only client between
  // reading and unlinking it. File-format markers require offline removal.
  return stat.isDirectory() ? "directory" : "legacy";
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
  return readMarker(join(dataDir, LOCK_FILENAME)) === "legacy";
}

/** Keep the exclusive transaction open until all store work has finished. */
export function acquireDataDirLock(dataDir: string): DataDirLock {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, LOCK_FILENAME);
  const recordPath = join(lockPath, "owner.json");
  const owner = new Database(join(dataDir, OWNER_DB_FILENAME), { timeout: 0 });
  try {
    // SQLite can reopen an unwritable file read-only and silently turn BEGIN
    // EXCLUSIVE into a read transaction. An actual write must succeed first.
    owner.exec("BEGIN EXCLUSIVE; PRAGMA user_version = 1");
    const marker = readMarker(lockPath);
    if (marker === "legacy") {
      throw new AppError(
        "DATA_DIR_LOCKED",
        `An older process may own ${lockPath}. Stop all journal processes and containers using this directory, then remove the legacy lock file if it remains.`,
        409,
      );
    }
    if (marker === "missing") mkdirSync(lockPath);
    else rmSync(recordPath, { force: true });
    // A crash during this diagnostic write leaves a recognizable directory.
    writeFileSync(
      recordPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: "wx" },
    );
  } catch (error) {
    owner.close();
    if (
      error instanceof Database.SqliteError &&
      error.code.startsWith("SQLITE_READONLY")
    ) {
      throw new AppError(
        "DATA_DIR_LOCK_UNWRITABLE",
        `The journal process needs write access to ${join(dataDir, OWNER_DB_FILENAME)} to own this data directory.`,
        500,
      );
    }
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
        unlinkSync(recordPath);
        rmdirSync(lockPath);
      } finally {
        owner.close();
      }
    },
  };
}

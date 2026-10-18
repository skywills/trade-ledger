import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { extract, list } from "tar";
import { AppError } from "../../shared/errors.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import {
  BACKUP_FORMAT,
  BACKUP_MANIFEST_VERSION,
  BACKUP_ROOTS,
  type BackupManifest,
  MANIFEST_FILENAME,
  SNAPSHOT_FILENAME,
} from "./backup.js";
import { acquireDataDirLock, type DataDirLock, LOCK_FILENAME } from "./lock.js";

/**
 * Restore works entirely inside the data directory so it also runs where the
 * data directory is a mount point (Docker `/data`): the parent may be
 * unwritable and the directory itself cannot be renamed. The archive is staged
 * in `<dataDir>/.restore-staging-*`, the current entries are moved aside into
 * `<dataDir>/.pre-restore-*` (kept as the pre-restore backup), and the staged
 * entries are moved in. Every move is a same-directory rename.
 */
const STAGING_PREFIX = ".restore-staging-";
const PRE_RESTORE_PREFIX = ".pre-restore-";

interface ArchiveEntry {
  readonly path: string;
  readonly type: string;
}

function invalid(message: string): AppError {
  return new AppError("BACKUP_INVALID", message, 400);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A non-validation failure (filesystem, permissions) during the restore. */
function restoreFailed(error: unknown): AppError {
  return new AppError(
    "RESTORE_FAILED",
    `The backup could not be restored: ${describeError(error)}`,
    500,
  );
}

/** Entries the swap never moves: the held lock and restore bookkeeping. */
function isReservedEntry(name: string): boolean {
  return (
    name === LOCK_FILENAME ||
    name.startsWith(STAGING_PREFIX) ||
    name.startsWith(PRE_RESTORE_PREFIX)
  );
}

/**
 * Rejects entries that could escape the extraction root: absolute paths,
 * parent-directory traversal, or link entries that could point outside.
 */
function isUnsafeEntry(entry: ArchiveEntry): boolean {
  if (entry.path === "" || entry.path.startsWith("/")) return true;
  if (isAbsolute(entry.path)) return true;
  const segments = entry.path.split(/[/\\]+/);
  if (segments.includes("..")) return true;
  if (entry.type === "SymbolicLink" || entry.type === "Link") return true;
  return false;
}

/** Normalizes a tar path (`./originals/x/` -> `originals/x`). */
function normalizeEntryPath(path: string): string {
  return path
    .split(/[/\\]+/)
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

async function readArchiveEntries(
  archivePath: string,
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  try {
    await list({
      file: archivePath,
      onReadEntry: (entry) => {
        entries.push({ path: entry.path, type: entry.type });
      },
    });
  } catch (error) {
    throw invalid(`The archive could not be read: ${describeError(error)}`);
  }
  return entries;
}

function parseManifest(raw: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid("The backup manifest is not valid JSON.");
  }
  const manifest = parsed as Partial<BackupManifest>;
  if (
    manifest.format !== BACKUP_FORMAT ||
    typeof manifest.manifestVersion !== "number" ||
    manifest.manifestVersion > BACKUP_MANIFEST_VERSION
  ) {
    throw invalid(
      "The backup manifest is missing or from an unsupported format.",
    );
  }
  if (
    typeof manifest.schemaVersion !== "number" ||
    !Number.isSafeInteger(manifest.schemaVersion)
  ) {
    throw invalid("The backup manifest does not record a schema version.");
  }
  if (
    manifest.database === undefined ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.originals) ||
    !Array.isArray(manifest.transcripts)
  ) {
    throw invalid("The backup manifest is incomplete.");
  }
  return manifest as BackupManifest;
}

function checkSchemaVersion(version: number): void {
  if (version < 1 || version > CURRENT_SCHEMA_VERSION) {
    throw invalid(
      `The backup uses schema version ${version}, which this application (max ${CURRENT_SCHEMA_VERSION}) cannot restore.`,
    );
  }
}

/**
 * Only the backup allowlist is restorable: the database snapshot itself, or a
 * file below one of the allowlisted directories. This also keeps a manifest
 * from naming the lock file or restore bookkeeping directories.
 */
function isRestorablePath(path: string): boolean {
  if (path === SNAPSHOT_FILENAME) return true;
  const [root, ...rest] = path.split("/");
  return (
    rest.length > 0 &&
    root !== SNAPSHOT_FILENAME &&
    (BACKUP_ROOTS as readonly string[]).includes(root ?? "")
  );
}

/**
 * Rejects the archive before extraction when it holds any file the manifest
 * does not list (for example a `journal.sqlite-wal` that SQLite would replay
 * over the checksummed snapshot). Directory entries are allowed only when they
 * are ancestors of a listed file.
 */
function assertEntriesListed(
  entries: readonly ArchiveEntry[],
  manifest: BackupManifest,
): void {
  const files = new Set<string>([MANIFEST_FILENAME]);
  const directories = new Set<string>([""]);
  for (const file of manifest.files) {
    const path = normalizeEntryPath(String(file.path));
    if (!isRestorablePath(path)) {
      throw invalid(`The manifest references an unsafe path: ${file.path}.`);
    }
    files.add(path);
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  for (const entry of entries) {
    const path = normalizeEntryPath(entry.path);
    const listed =
      entry.type === "Directory" ? directories.has(path) : files.has(path);
    if (!listed) {
      throw invalid(
        `The archive contains an entry the manifest does not list: ${entry.path}.`,
      );
    }
  }
}

function hashFile(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * Validates every file recorded in the manifest: each must exist in staging
 * with a matching size and sha256. A missing or tampered file rejects the
 * restore before any replacement.
 */
function validateFiles(stagingDir: string, manifest: BackupManifest): void {
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const absPath = resolve(stagingDir, entry.path);
    if (
      absPath !== resolve(stagingDir) &&
      !absPath.startsWith(resolve(stagingDir) + sep)
    ) {
      throw invalid(`The manifest references an unsafe path: ${entry.path}.`);
    }
    if (!existsSync(absPath)) {
      throw invalid(`A referenced backup file is missing: ${entry.path}.`);
    }
    if (statSync(absPath).size !== entry.size) {
      throw invalid(`A referenced backup file is truncated: ${entry.path}.`);
    }
    if (hashFile(absPath) !== entry.sha256) {
      throw invalid(`A referenced backup file is corrupted: ${entry.path}.`);
    }
  }
  if (!seen.has(SNAPSHOT_FILENAME)) {
    throw invalid("The backup does not include a database snapshot.");
  }
}

function readSnapshot(dbPath: string): { integrity: unknown; version: number } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null } | undefined;
    return { integrity, version: row?.version ?? 0 };
  } finally {
    db.close();
  }
}

/**
 * Opens the staged snapshot read-only and checks it is an intact journal
 * database whose recorded schema version (the highest applied migration)
 * matches the manifest and is supported by this application.
 */
function verifySnapshot(stagingDir: string, manifest: BackupManifest): void {
  const dbPath = join(stagingDir, SNAPSHOT_FILENAME);
  let snapshot: { integrity: unknown; version: number };
  try {
    snapshot = readSnapshot(dbPath);
  } catch (error) {
    throw invalid(
      `The database snapshot is not a valid journal database: ${describeError(error)}`,
    );
  } finally {
    // A read-only open may leave WAL side files; they must not be restored.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
  if (snapshot.integrity !== "ok") {
    throw invalid(
      `The database snapshot failed its integrity check: ${String(snapshot.integrity)}`,
    );
  }
  checkSchemaVersion(snapshot.version);
  if (snapshot.version !== manifest.schemaVersion) {
    throw invalid(
      `The database snapshot records schema version ${snapshot.version}, but the manifest declares ${manifest.schemaVersion}.`,
    );
  }
}

function moveEntries(
  names: readonly string[],
  fromDir: string,
  toDir: string,
): void {
  for (const name of names) renameSync(join(fromDir, name), join(toDir, name));
}

/**
 * Swaps the data directory's contents entry by entry: current entries move
 * into a `.pre-restore-*` directory (kept as the pre-restore backup), then the
 * staged entries move in. The lock and restore bookkeeping never move. On a
 * failure every completed move is undone.
 */
function swapIn(stagingDir: string, targetDir: string): void {
  const existing = readdirSync(targetDir)
    .filter((name) => !isReservedEntry(name))
    .sort();
  const incoming = readdirSync(stagingDir).sort();
  const preRestoreDir =
    existing.length === 0
      ? null
      : mkdtempSync(join(targetDir, `${PRE_RESTORE_PREFIX}${Date.now()}-`));

  const movedOut: string[] = [];
  const movedIn: string[] = [];
  try {
    for (const name of existing) {
      moveEntries([name], targetDir, preRestoreDir as string);
      movedOut.push(name);
    }
    for (const name of incoming) {
      moveEntries([name], stagingDir, targetDir);
      movedIn.push(name);
    }
  } catch (error) {
    try {
      moveEntries(movedIn.reverse(), targetDir, stagingDir);
      if (preRestoreDir !== null) {
        moveEntries(movedOut.reverse(), preRestoreDir, targetDir);
        rmSync(preRestoreDir, { recursive: true, force: true });
      }
    } catch (rollbackError) {
      throw new AppError(
        "RESTORE_FAILED",
        `The backup could not be restored (${describeError(error)}) and the rollback failed (${describeError(rollbackError)}). The previous data is in ${preRestoreDir ?? targetDir}.`,
        500,
      );
    }
    throw error;
  }
}

async function stageArchive(
  archivePath: string,
  stagingDir: string,
): Promise<BackupManifest> {
  const entries = await readArchiveEntries(archivePath);
  const unsafe = entries.find(isUnsafeEntry);
  if (unsafe !== undefined) {
    throw invalid(`The archive contains an unsafe entry: ${unsafe.path}.`);
  }

  // Read the manifest alone first so unlisted entries are rejected before any
  // journal file is extracted.
  await extract({
    file: archivePath,
    cwd: stagingDir,
    filter: (path) => normalizeEntryPath(path) === MANIFEST_FILENAME,
  });
  const manifestPath = join(stagingDir, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw invalid("The archive does not contain a manifest.");
  }
  const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  checkSchemaVersion(manifest.schemaVersion);
  assertEntriesListed(entries, manifest);

  await extract({
    file: archivePath,
    cwd: stagingDir,
    filter: (path) =>
      !isUnsafeEntry({ path, type: "File" }) &&
      normalizeEntryPath(path) !== MANIFEST_FILENAME,
  });
  validateFiles(stagingDir, manifest);
  verifySnapshot(stagingDir, manifest);
  // The manifest is archive metadata, not journal data.
  rmSync(manifestPath, { force: true });
  return manifest;
}

/**
 * Restores an archive into a stopped instance. Offline CLI only: it acquires
 * the data-directory lock for the whole restore, so it refuses while a live
 * process holds it and no server can start mid-restore. The archive is staged
 * inside the data directory; unlisted entries, missing or tampered files, a
 * corrupt snapshot and a schema version that does not match the snapshot or
 * is newer than this application all reject before any replacement. Only then
 * are the contents swapped in, keeping the replaced entries as the pre-restore
 * backup. Filesystem failures surface as RESTORE_FAILED, not BACKUP_INVALID.
 */
export async function restoreBackup(
  archivePath: string,
  targetDir: string,
): Promise<void> {
  if (!existsSync(archivePath)) {
    throw invalid(`No backup archive exists at ${archivePath}.`);
  }
  const target = resolve(targetDir);
  let lock: DataDirLock | undefined;
  let stagingDir: string | undefined;
  try {
    // The lock lives at <target>/journal.lock and is never moved by the swap.
    lock = acquireDataDirLock(target);
    stagingDir = mkdtempSync(join(target, STAGING_PREFIX));
    await stageArchive(archivePath, stagingDir);
    swapIn(stagingDir, target);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw restoreFailed(error);
  } finally {
    if (stagingDir !== undefined) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
    lock?.release();
  }
}

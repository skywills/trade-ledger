import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { extract, list } from "tar";
import { AppError } from "../../shared/errors.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";
import {
  BACKUP_FORMAT,
  BACKUP_MANIFEST_VERSION,
  type BackupManifest,
  MANIFEST_FILENAME,
  SNAPSHOT_FILENAME,
} from "./backup.js";
import { isDataDirLocked, LOCK_FILENAME } from "./lock.js";

interface ArchiveEntry {
  readonly path: string;
  readonly type: string;
}

function invalid(message: string): AppError {
  return new AppError("BACKUP_INVALID", message, 400);
}

function assertNotLocked(targetDir: string): void {
  if (isDataDirLocked(targetDir)) {
    throw new AppError(
      "DATA_DIR_LOCKED",
      "Stop the running journal instance before restoring a backup.",
      409,
    );
  }
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
    throw invalid(
      `The archive could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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

function checkSchemaCompatibility(manifest: BackupManifest): void {
  if (
    manifest.schemaVersion < 1 ||
    manifest.schemaVersion > CURRENT_SCHEMA_VERSION
  ) {
    throw invalid(
      `The backup uses schema version ${manifest.schemaVersion}, which this application (max ${CURRENT_SCHEMA_VERSION}) cannot restore.`,
    );
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

/**
 * Preserves the current instance before replacement. The copy is a verbatim,
 * lock-free directory copy next to the target so an operator can recover the
 * prior state if the restore is later rejected or reverted.
 */
function makePreRestoreBackup(targetDir: string): void {
  if (!existsSync(targetDir)) return;
  const parent = dirname(resolve(targetDir));
  const name = resolve(targetDir).split(sep).pop() ?? "data";
  const destination = join(parent, `${name}.pre-restore-${Date.now()}`);
  cpSync(targetDir, destination, {
    recursive: true,
    filter: (source) => !source.endsWith(LOCK_FILENAME),
  });
}

function swapIn(stagingDir: string, targetDir: string): void {
  const target = resolve(targetDir);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target)) {
    renameSync(stagingDir, target);
    return;
  }
  const trash = `${target}.replaced-${Date.now()}`;
  renameSync(target, trash);
  try {
    renameSync(stagingDir, target);
  } catch (error) {
    renameSync(trash, target);
    throw error;
  }
  rmSync(trash, { recursive: true, force: true });
}

/**
 * Restores an archive into a stopped instance. Offline CLI only: it refuses
 * while a live process holds the data-directory lock. The archive is extracted
 * to a validated staging directory, every referenced file and the schema
 * version are validated (a newer schema or a missing/tampered file rejects
 * before any replacement), a pre-restore backup is made, and only then is the
 * data directory swapped in.
 */
export async function restoreBackup(
  archivePath: string,
  targetDir: string,
): Promise<void> {
  if (!existsSync(archivePath)) {
    throw invalid(`No backup archive exists at ${archivePath}.`);
  }
  assertNotLocked(targetDir);

  const parent = dirname(resolve(targetDir));
  mkdirSync(parent, { recursive: true });
  const stagingDir = mkdtempSync(join(parent, ".ibkr-restore-"));
  let swapped = false;
  try {
    const entries = await readArchiveEntries(archivePath);
    const unsafe = entries.find(isUnsafeEntry);
    if (unsafe !== undefined) {
      throw invalid(`The archive contains an unsafe entry: ${unsafe.path}.`);
    }

    await extract({
      file: archivePath,
      cwd: stagingDir,
      filter: (path) => !isUnsafeEntry({ path, type: "File" }),
    });

    const manifestPath = join(stagingDir, MANIFEST_FILENAME);
    if (!existsSync(manifestPath)) {
      throw invalid("The archive does not contain a manifest.");
    }
    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    checkSchemaCompatibility(manifest);
    validateFiles(stagingDir, manifest);
    // The manifest is archive metadata, not journal data.
    rmSync(manifestPath, { force: true });

    // Re-check the lock immediately before touching the target: a process that
    // started during extraction/validation must never be replaced under.
    assertNotLocked(targetDir);
    makePreRestoreBackup(targetDir);
    assertNotLocked(targetDir);
    swapIn(stagingDir, targetDir);
    swapped = true;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid(
      `The backup could not be restored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    if (!swapped) {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

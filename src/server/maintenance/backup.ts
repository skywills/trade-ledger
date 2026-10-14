import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { create, list } from "tar";
import { AppError } from "../../shared/errors.js";
import { listImports } from "../imports/service.js";
import type { Store } from "../storage/database.js";
import { CURRENT_SCHEMA_VERSION } from "../storage/migrations.js";

export const BACKUP_FORMAT = "ibkr-trade-journal-backup";
export const BACKUP_MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = "manifest.json";
export const SNAPSHOT_FILENAME = "journal.sqlite";

/**
 * The allowlisted roots archived into a backup. Secrets live in environment
 * variables or under a separately mounted secrets directory and are never
 * under these roots, so the archive excludes them by construction rather than
 * by filename guessing.
 */
export const BACKUP_ROOTS = [
  SNAPSHOT_FILENAME,
  "originals",
  "transcripts",
] as const;

export interface BackupFileEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface BackupProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly mode: string;
  readonly provider: string;
  readonly modelId: string;
  readonly revision: number;
  readonly enabled: boolean;
}

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly manifestVersion: number;
  readonly appVersion: string;
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly decisionWatermark: number;
  readonly database: BackupFileEntry;
  readonly originals: BackupFileEntry[];
  readonly transcripts: BackupFileEntry[];
  readonly files: BackupFileEntry[];
  readonly profiles: BackupProfileRecord[];
}

export interface CreateBackupOptions {
  /** Test seam: awaited inside the consistency barrier before the snapshot. */
  readonly beforeSnapshot?: () => Promise<void> | void;
  readonly signal?: AbortSignal;
}

interface CapturedFile {
  readonly relPath: string;
  readonly absPath: string;
}

interface CapturedState {
  readonly watermark: number;
  readonly schemaVersion: number;
  readonly originals: CapturedFile[];
  readonly transcripts: CapturedFile[];
  readonly profiles: BackupProfileRecord[];
}

function posixRelative(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

function toEntry(stagingDir: string, relPath: string): BackupFileEntry {
  const absPath = join(stagingDir, relPath);
  return {
    path: relPath,
    sha256: sha256File(absPath),
    size: statSync(absPath).size,
  };
}

function appVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  // The compiled entry point lives at dist/src/server/maintenance, so the
  // manifest shipped in the runtime image at /app/package.json is four levels
  // up; the local build also keeps a copy at the repository root (three levels
  // up from a source layout). Fall back to the working directory so a packaged
  // deployment records its real version instead of 0.0.0.
  const candidates = [
    new URL("../../../../package.json", import.meta.url),
    new URL("../../../package.json", import.meta.url),
    pathToFileURL(join(process.cwd(), "package.json")),
  ];
  for (const url of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(url, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version !== "") {
        return parsed.version;
      }
    } catch {
      // Try the next candidate location.
    }
  }
  return "0.0.0";
}

function collectOriginals(store: Store): CapturedFile[] {
  const files: CapturedFile[] = [];
  for (const record of listImports(store)) {
    const absPath = join(store.dataDir, record.originalFilePath);
    if (!existsSync(absPath)) {
      throw new AppError(
        "BACKUP_SOURCE_INCOMPLETE",
        `Committed import ${record.id} references a missing original file.`,
        500,
      );
    }
    files.push({ relPath: record.originalFilePath, absPath });
  }
  return files;
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function collectTranscripts(store: Store): CapturedFile[] {
  const root = join(store.dataDir, "transcripts");
  return walkFiles(root).map((absPath) => ({
    relPath: posixRelative(store.dataDir, absPath),
    absPath,
  }));
}

function collectProfiles(store: Store): BackupProfileRecord[] {
  const rows = store.db
    .prepare(
      `SELECT id, name, mode, provider_adapter, model_id, revision, enabled
       FROM llm_profiles ORDER BY name ASC`,
    )
    .all() as Array<{
    id: string;
    name: string;
    mode: string;
    provider_adapter: string;
    model_id: string;
    revision: number;
    enabled: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    mode: row.mode,
    provider: row.provider_adapter,
    modelId: row.model_id,
    revision: row.revision,
    enabled: row.enabled === 1,
  }));
}

function readSchemaVersion(store: Store): number {
  const row = store.db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

function copyIntoStaging(stagingDir: string, files: CapturedFile[]): void {
  for (const file of files) {
    const destination = join(stagingDir, file.relPath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.absPath, destination);
  }
}

/**
 * Takes a consistent snapshot. A serialized barrier is enqueued on the writer
 * queue so source/decision mutations and transcript-writing work drain and then
 * pause; the decision watermark and the manifest of committed imports and
 * referenced transcript files are read, `better-sqlite3`'s online backup writes
 * a consistent database image without holding a transaction across the await,
 * and the mutable transcript bytes are copied into staging. Only then is the
 * barrier released, so no in-flight change can enter a half snapshot. Secrets
 * are excluded because only the allowlisted roots are archived.
 */
export async function createBackup(
  store: Store,
  outputPath: string,
  options: CreateBackupOptions = {},
): Promise<BackupManifest> {
  const stagingDir = await mkdtemp(join(tmpdir(), "ibkr-backup-stage-"));
  try {
    const snapshotPath = join(stagingDir, SNAPSHOT_FILENAME);
    const captured = await store.queue.enqueue(
      async (): Promise<CapturedState> => {
        const schemaVersion = readSchemaVersion(store);
        const originals = collectOriginals(store);
        const transcripts = collectTranscripts(store);
        const profiles = collectProfiles(store);
        // Read the decision watermark and referenced files while writes are
        // paused, then snapshot the database and copy the mutable bytes.
        const decisionWatermark = readDecisionWatermark(store);
        await options.beforeSnapshot?.();
        if (options.signal?.aborted) {
          throw new AppError(
            "BACKUP_CANCELLED",
            "The backup was cancelled.",
            409,
          );
        }
        await store.db.backup(snapshotPath);
        copyIntoStaging(stagingDir, originals);
        copyIntoStaging(stagingDir, transcripts);
        return {
          watermark: decisionWatermark,
          schemaVersion,
          originals,
          transcripts,
          profiles,
        };
      },
    );

    if (options.signal?.aborted) {
      throw new AppError("BACKUP_CANCELLED", "The backup was cancelled.", 409);
    }

    const database = toEntry(stagingDir, SNAPSHOT_FILENAME);
    const originals = captured.originals.map((file) =>
      toEntry(stagingDir, file.relPath),
    );
    const transcripts = captured.transcripts.map((file) =>
      toEntry(stagingDir, file.relPath),
    );
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      manifestVersion: BACKUP_MANIFEST_VERSION,
      appVersion: appVersion(),
      schemaVersion:
        captured.schemaVersion === 0
          ? CURRENT_SCHEMA_VERSION
          : captured.schemaVersion,
      createdAt: new Date().toISOString(),
      decisionWatermark: captured.watermark,
      database,
      originals,
      transcripts,
      files: [database, ...originals, ...transcripts],
      profiles: captured.profiles,
    };
    writeFileSync(
      join(stagingDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
    );

    mkdirSync(dirname(outputPath), { recursive: true });
    const entries = readdirSync(stagingDir);
    await create(
      { file: outputPath, cwd: stagingDir, portable: true },
      entries,
    );
    return manifest;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function readDecisionWatermark(store: Store): number {
  const row = store.db
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM decisions")
    .get() as { sequence: number };
  return row.sequence;
}

/** Lists every entry path in an archive, in tar order. */
export async function listBackupEntries(
  archivePath: string,
): Promise<string[]> {
  if (!existsSync(archivePath)) {
    throw new AppError(
      "BACKUP_INVALID",
      `No backup archive exists at ${archivePath}.`,
      400,
    );
  }
  const entries: string[] = [];
  await list({
    file: archivePath,
    onReadEntry: (entry) => {
      entries.push(entry.path);
    },
  });
  return entries;
}

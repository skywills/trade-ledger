import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SHARD_PATTERN = /^[0-9a-f]{2}$/;
export const STAGING_DIRNAME = ".staging";
const STAGING_SUFFIX = ".part";

/**
 * Filesystem mechanics for content-addressed original storage. Paths are
 * derived only from content hashes and application-generated identifiers;
 * user-supplied filenames never reach this module. Every exported path is
 * verified to resolve inside the data directory before it is touched.
 */

function assertSha256(hash: string): void {
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`Malformed content hash: ${hash}`);
  }
}

export function stagingRelativePath(previewId: string): string {
  return `originals/${STAGING_DIRNAME}/${previewId}${STAGING_SUFFIX}`;
}

export function contentRelativePath(sha256: string): string {
  assertSha256(sha256);
  return `originals/${sha256.slice(0, 2)}/${sha256}`;
}

export function resolveInsideRoot(root: string, relativePath: string): string {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(
      `Refusing to access a path outside ${base}: ${relativePath}`,
    );
  }
  return target;
}

function fsyncDirectory(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms; best effort only.
  } finally {
    closeSync(fd);
  }
}

/** Stages original bytes durably under an identifier-derived staging name. */
export function stageOriginalBytes(
  sourceRoot: string,
  previewId: string,
  bytes: Uint8Array,
): void {
  const stagingDir = join(sourceRoot, STAGING_DIRNAME);
  mkdirSync(stagingDir, { recursive: true });
  const target = resolveInsideRoot(stagingDir, `${previewId}${STAGING_SUFFIX}`);
  const fd = openSync(target, "w");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(stagingDir);
}

/**
 * Renames staged bytes to their content-addressed immutable destination.
 * When the destination already exists the staged copy is discarded (the
 * content is identical by hash). When the staged copy is missing but the
 * destination exists the promotion already happened (a crash between the
 * rename and the database commit) and the call is a no-op.
 */
export function promoteStagedOriginal(
  sourceRoot: string,
  sha256: string,
  previewId: string,
): void {
  assertSha256(sha256);
  const stagingDir = join(sourceRoot, STAGING_DIRNAME);
  const stagedPath = resolveInsideRoot(
    stagingDir,
    `${previewId}${STAGING_SUFFIX}`,
  );
  const destination = resolveInsideRoot(
    sourceRoot,
    join(sha256.slice(0, 2), sha256),
  );
  if (existsSync(stagedPath)) {
    if (existsSync(destination)) {
      rmSync(stagedPath);
      return;
    }
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(stagedPath, destination);
    fsyncDirectory(dirname(destination));
    return;
  }
  if (!existsSync(destination)) {
    throw new Error(
      `Staged original bytes for preview ${previewId} are missing and no content file exists for ${sha256}.`,
    );
  }
}

export function readDataFile(
  dataDir: string,
  relativePath: string,
): Uint8Array {
  return new Uint8Array(readFileSync(resolveInsideRoot(dataDir, relativePath)));
}

export function dataFileExists(dataDir: string, relativePath: string): boolean {
  return existsSync(resolveInsideRoot(dataDir, relativePath));
}

export function removeDataFileQuietly(
  dataDir: string,
  relativePath: string,
): void {
  try {
    rmSync(resolveInsideRoot(dataDir, relativePath), { force: true });
  } catch {
    // Reclamation is best effort; a later recovery pass retries.
  }
}

export function listStagedPreviewIds(sourceRoot: string): string[] {
  const stagingDir = join(sourceRoot, STAGING_DIRNAME);
  if (!existsSync(stagingDir)) return [];
  return readdirSync(stagingDir)
    .filter((name) => name.endsWith(STAGING_SUFFIX))
    .map((name) => name.slice(0, -STAGING_SUFFIX.length));
}

export function listContentHashes(sourceRoot: string): string[] {
  if (!existsSync(sourceRoot)) return [];
  const hashes: string[] = [];
  for (const shard of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!shard.isDirectory() || !SHARD_PATTERN.test(shard.name)) continue;
    for (const entry of readdirSync(join(sourceRoot, shard.name), {
      withFileTypes: true,
    })) {
      if (entry.isFile() && SHA256_PATTERN.test(entry.name)) {
        hashes.push(entry.name);
      }
    }
  }
  return hashes;
}

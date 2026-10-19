import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { create, extract } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { readConfig } from "../../src/server/config.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  createBackup,
  listBackupEntries,
} from "../../src/server/maintenance/backup.js";
import {
  acquireDataDirLock,
  isDataDirLocked,
  RESTORE_MARKER_FILENAME,
} from "../../src/server/maintenance/lock.js";
import { restoreBackup } from "../../src/server/maintenance/restore.js";
import { closeStore, openStore } from "../../src/server/storage/database.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/server/storage/migrations.js";
import { fixtures } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

const tempRoots: string[] = [];
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function trackTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    chmodRecursive(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Restores write access so temp roots made read-only by a test can be removed. */
function chmodRecursive(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodRecursive(join(dir, entry.name));
  }
}

async function makeArchive(): Promise<string> {
  const { store, dispose } = await createTestStore();
  const archive = join(trackTemp("ibkr-hardening-out-"), "backup.tar");
  try {
    const preview = await previewImport(store, {
      filename: "spread.csv",
      bytes: fixtures.spread,
      timezone: "UTC",
    });
    await commitImport(store, preview.id);
    await createBackup(store, archive);
  } finally {
    await dispose();
  }
  return archive;
}

interface ManifestShape {
  schemaVersion: number;
  database: { path: string; sha256: string; size: number };
  files: Array<{ path: string; sha256: string; size: number }>;
}

/** Extracts an archive, lets the test mutate it, and repacks it. */
async function repack(
  archive: string,
  mutate: (staging: string) => void,
): Promise<string> {
  const staging = trackTemp("ibkr-hardening-stage-");
  await extract({ file: archive, cwd: staging });
  mutate(staging);
  const output = join(dirname(archive), `repacked-${Date.now()}.tar`);
  await create({ file: output, cwd: staging }, ["."]);
  return output;
}

/** Rewrites the manifest checksum of the staged database to match its bytes. */
function rehashDatabase(staging: string): void {
  const manifestPath = join(staging, "manifest.json");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ManifestShape;
  const dbPath = join(staging, "journal.sqlite");
  const entry = {
    path: "journal.sqlite",
    sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
    size: statSync(dbPath).size,
  };
  manifest.database = entry;
  manifest.files = manifest.files.map((file) =>
    file.path === "journal.sqlite" ? entry : file,
  );
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

function makeExistingTarget(): string {
  const targetDir = join(trackTemp("ibkr-hardening-target-"), "data");
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, "keep-marker.txt"), "keep");
  return targetDir;
}

describe("restore hardening (R03)", () => {
  it("holds the data-dir lock for the whole restore and releases it after", async () => {
    const archive = await makeArchive();
    const targetDir = makeExistingTarget();

    const pending = restoreBackup(archive, targetDir);
    expect(isDataDirLocked(targetDir)).toBe(true);
    expect(() => acquireDataDirLock(targetDir)).toThrow(
      expect.objectContaining({ code: "DATA_DIR_LOCKED" }),
    );
    await pending;
    expect(isDataDirLocked(targetDir)).toBe(false);
    expect(existsSync(join(targetDir, "journal.lock"))).toBe(false);
  });

  it("releases the lock when the restore is rejected", async () => {
    const archive = await makeArchive();
    const tampered = await repack(archive, (staging) => {
      writeFileSync(join(staging, "journal.sqlite"), "not a database");
    });
    const targetDir = makeExistingTarget();
    await expect(restoreBackup(tampered, targetDir)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
    expect(isDataDirLocked(targetDir)).toBe(false);
  });

  it("rejects an archive entry that the manifest does not list", async () => {
    const archive = await makeArchive();
    const withWal = await repack(archive, (staging) => {
      writeFileSync(join(staging, "journal.sqlite-wal"), "replayed pages");
    });
    const targetDir = makeExistingTarget();

    await expect(restoreBackup(withWal, targetDir)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
      message: expect.stringContaining("journal.sqlite-wal"),
    });
    expect(existsSync(join(targetDir, "journal.sqlite-wal"))).toBe(false);
    expect(readFileSync(join(targetDir, "keep-marker.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("rejects a database snapshot that is not a valid SQLite file", async () => {
    const archive = await makeArchive();
    const garbage = await repack(archive, (staging) => {
      writeFileSync(join(staging, "journal.sqlite"), "x".repeat(8192));
      rehashDatabase(staging);
    });
    const targetDir = makeExistingTarget();

    await expect(restoreBackup(garbage, targetDir)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
    });
    expect(readFileSync(join(targetDir, "keep-marker.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it("reads the schema version from the database file, not the manifest", async () => {
    const archive = await makeArchive();
    const newer = await repack(archive, (staging) => {
      const db = new Database(join(staging, "journal.sqlite"));
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(CURRENT_SCHEMA_VERSION + 1, new Date().toISOString());
      db.pragma("journal_mode = DELETE");
      db.close();
      rehashDatabase(staging);
    });
    const targetDir = makeExistingTarget();

    await expect(restoreBackup(newer, targetDir)).rejects.toMatchObject({
      code: "BACKUP_INVALID",
      message: expect.stringContaining("schema version"),
    });
    expect(readFileSync(join(targetDir, "keep-marker.txt"), "utf8")).toBe(
      "keep",
    );
  });

  it.skipIf(isRoot)(
    "restores into a mount-point style data dir whose parent is read-only",
    async () => {
      const archive = await makeArchive();
      const parent = trackTemp("ibkr-hardening-mount-");
      const targetDir = join(parent, "data");
      const existing = openStore(targetDir);
      await closeStore(existing);
      writeFileSync(join(targetDir, "keep-marker.txt"), "keep");
      chmodSync(parent, 0o555);

      try {
        await restoreBackup(archive, targetDir);
      } finally {
        chmodSync(parent, 0o755);
      }

      expect(readdirSync(parent)).toEqual(["data"]);
      const entries = readdirSync(targetDir);
      expect(entries).toContain("journal.sqlite");
      expect(entries).not.toContain("keep-marker.txt");
      expect(entries.some((name) => name.startsWith(".restore-staging"))).toBe(
        false,
      );
      const preRestore = entries.filter((name) =>
        name.startsWith(".pre-restore-"),
      );
      expect(preRestore).toHaveLength(1);
      const preRestoreDir = join(targetDir, preRestore[0] as string);
      expect(readFileSync(join(preRestoreDir, "keep-marker.txt"), "utf8")).toBe(
        "keep",
      );
      expect(existsSync(join(preRestoreDir, "journal.sqlite"))).toBe(true);
      expect(existsSync(join(preRestoreDir, "journal.lock"))).toBe(false);

      const restored = openStore(targetDir);
      try {
        const count = restored.db
          .prepare("SELECT COUNT(*) AS count FROM imports")
          .get() as { count: number };
        expect(count.count).toBe(1);
        const next = join(trackTemp("ibkr-hardening-next-"), "next.tar");
        await createBackup(restored, next);
        const archived = await listBackupEntries(next);
        expect(
          archived.some(
            (entry) =>
              entry.includes(".pre-restore-") ||
              entry.includes(".restore-staging-"),
          ),
        ).toBe(false);
      } finally {
        await closeStore(restored);
      }
    },
  );

  it("does not move earlier pre-restore backups into a later one", async () => {
    const archive = await makeArchive();
    const targetDir = makeExistingTarget();
    await restoreBackup(archive, targetDir);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await restoreBackup(archive, targetDir);

    const preRestore = readdirSync(targetDir).filter((name) =>
      name.startsWith(".pre-restore-"),
    );
    expect(preRestore).toHaveLength(2);
    for (const name of preRestore) {
      const inner = readdirSync(join(targetDir, name));
      expect(inner.some((entry) => entry.startsWith(".pre-restore-"))).toBe(
        false,
      );
    }
  });

  it.skipIf(isRoot)(
    "reports a filesystem failure as RESTORE_FAILED and rolls back the swap",
    async () => {
      const archive = await makeArchive();
      const targetDir = makeExistingTarget();
      // A directory without write permission cannot be re-parented, so moving
      // it aside fails mid-swap with EACCES.
      const stuck = join(targetDir, "zz-stuck");
      mkdirSync(stuck);
      writeFileSync(join(stuck, "inner.txt"), "inner");
      chmodSync(stuck, 0o555);

      let caught: unknown;
      try {
        await restoreBackup(archive, targetDir);
      } catch (error) {
        caught = error;
      } finally {
        chmodSync(stuck, 0o755);
      }
      expect(caught).toMatchObject({
        code: "RESTORE_FAILED",
        statusCode: 500,
        message: expect.stringContaining("EACCES"),
      });
      expect(readdirSync(targetDir).sort()).toEqual([
        "keep-marker.txt",
        "zz-stuck",
      ]);
      expect(isDataDirLocked(targetDir)).toBe(false);
    },
  );

  it("refuses to start on a data dir whose restore swap never finished", async () => {
    const dataDir = trackTemp("ibkr-hardening-marker-");
    writeFileSync(
      join(dataDir, RESTORE_MARKER_FILENAME),
      ".pre-restore-123-abc\n",
    );
    await expect(
      createApp(
        readConfig({
          DATA_DIR: dataDir,
          ALLOWED_ORIGIN: "http://localhost:3000",
        }),
      ),
    ).rejects.toMatchObject({ code: "RESTORE_INCOMPLETE" });
    expect(existsSync(join(dataDir, "journal.sqlite"))).toBe(false);
    expect(isDataDirLocked(dataDir)).toBe(false);
  });

  it("leaves no in-progress marker after a completed restore", async () => {
    const archive = await makeArchive();
    const target = makeExistingTarget();
    await restoreBackup(archive, target);
    expect(existsSync(join(target, RESTORE_MARKER_FILENAME))).toBe(false);
  });
});

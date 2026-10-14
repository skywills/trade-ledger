import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { create } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { readConfig } from "../../src/server/config.js";
import {
  notesInput,
  rejectionInput,
} from "../../src/server/decisions/schemas.js";
import {
  appendDecision,
  decisionWatermark,
  readDecisions,
} from "../../src/server/decisions/service.js";
import { contentRelativePath } from "../../src/server/imports/files.js";
import {
  commitImport,
  listImports,
  previewImport,
} from "../../src/server/imports/service.js";
import { JobService } from "../../src/server/jobs/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import {
  createBackup,
  listBackupEntries,
} from "../../src/server/maintenance/backup.js";
import {
  acquireDataDirLock,
  isDataDirLocked,
} from "../../src/server/maintenance/lock.js";
import { restoreBackup } from "../../src/server/maintenance/restore.js";
import { shutdown } from "../../src/server/maintenance/shutdown.js";
import {
  closeStore,
  openStore,
  type Store,
} from "../../src/server/storage/database.js";
import { fixtures } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

const ORIGIN = "http://localhost:3000";

const tempRoots: string[] = [];
const openApps: Array<{ close: () => Promise<void> }> = [];
let capturedStore: Store | undefined;

function trackTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function commitBytes(
  store: Store,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const preview = await previewImport(store, {
    filename,
    bytes,
    timezone: "UTC",
  });
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
  return committed.importId;
}

async function seedStore(store: Store): Promise<void> {
  await commitBytes(store, "spread.csv", fixtures.spread);
  await appendDecision(
    store,
    notesInput({ strategyId: "strategy-1", text: "Held through volatility" }),
    0,
  );
  await appendDecision(
    store,
    rejectionInput({ evidenceHash: "abc123", reason: "stale proposal" }),
    1,
  );
  await rebuild(store, {
    mode: "full",
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
}

async function withFreshStore(
  dir: string,
  run: (store: Store) => Promise<void>,
): Promise<void> {
  const store = openStore(dir);
  try {
    await run(store);
  } finally {
    await closeStore(store);
  }
}

function listDirRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listDirRecursive(full));
    else results.push(full);
  }
  return results;
}

describe("consistent backup and offline restore", () => {
  it("roundtrips decisions and the active projection into a fresh data directory", async () => {
    const { store, dispose, dataDir } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-out-"), "backup.tar");
    try {
      await seedStore(store);
      const originalDecisions = readDecisions(store, decisionWatermark(store));
      const originalStrategies = activeProjection(store).projection?.strategies;

      const manifest = await createBackup(store, archive);
      expect(manifest.decisionWatermark).toBe(decisionWatermark(store));
      expect(manifest.schemaVersion).toBeGreaterThan(0);
      expect(manifest.appVersion).not.toBe("0.0.0");

      const freshDir = join(trackTemp("ibkr-restore-"), "data");
      await restoreBackup(archive, freshDir);
      expect(existsSync(join(freshDir, "manifest.json"))).toBe(false);

      await withFreshStore(freshDir, async (restored) => {
        expect(readDecisions(restored, decisionWatermark(restored))).toEqual(
          originalDecisions,
        );
        expect(activeProjection(restored).projection?.strategies).toEqual(
          originalStrategies,
        );
      });
      void dataDir;
    } finally {
      await dispose();
    }
  });

  it("resolves the real app version without relying on npm env", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-version-"), "backup.tar");
    const saved = process.env.npm_package_version;
    delete process.env.npm_package_version;
    try {
      await seedStore(store);
      const manifest = await createBackup(store, archive);
      expect(manifest.appVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(manifest.appVersion).not.toBe("0.0.0");
    } finally {
      if (saved !== undefined) process.env.npm_package_version = saved;
      await dispose();
    }
  });

  it("archives only allowlisted roots and never a secrets entry", async () => {
    const { store, dispose, dataDir } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-secret-"), "backup.tar");
    try {
      await seedStore(store);
      mkdirSync(join(dataDir, "secrets"), { recursive: true });
      writeFileSync(join(dataDir, "secrets", "provider-key"), "super-secret");

      await createBackup(store, archive);
      const entries = await listBackupEntries(archive);
      expect(entries).not.toContain("secrets/provider-key");
      expect(entries.some((entry) => entry.includes("secrets"))).toBe(false);
      expect(entries).toContain("manifest.json");
    } finally {
      await dispose();
    }
  });

  it("preserves originals, profile records, notes, rejections and source hashes", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-assets-"), "backup.tar");
    try {
      await seedStore(store);
      const imports = listImports(store);
      expect(imports.length).toBe(1);
      const sha = imports[0]?.sha256 ?? "";
      const originalBytes = readFileSync(
        join(store.dataDir, contentRelativePath(sha)),
      );

      const manifest = await createBackup(store, archive);
      expect(manifest.originals.some((entry) => entry.path.includes(sha))).toBe(
        true,
      );
      expect(
        manifest.files.some((entry) => entry.path === "journal.sqlite"),
      ).toBe(true);

      const freshDir = join(trackTemp("ibkr-restore-assets-"), "data");
      await restoreBackup(archive, freshDir);
      await withFreshStore(freshDir, async (restored) => {
        const restoredImports = listImports(restored);
        expect(restoredImports.map((item) => item.sha256)).toEqual([sha]);
        const restoredBytes = readFileSync(
          join(restored.dataDir, contentRelativePath(sha)),
        );
        expect(restoredBytes.equals(originalBytes)).toBe(true);
        const decisions = readDecisions(restored, decisionWatermark(restored));
        expect(decisions.map((decision) => decision.kind)).toEqual([
          "notes",
          "rejection",
        ]);
        expect(decisions[1]?.payload).toMatchObject({ evidenceHash: "abc123" });
      });
    } finally {
      await dispose();
    }
  });

  it("captures mutable transcripts and restores their exact bytes", async () => {
    const { store, dispose, dataDir } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-transcript-"), "backup.tar");
    try {
      await seedStore(store);
      const transcriptDir = join(dataDir, "transcripts", "analysis");
      mkdirSync(transcriptDir, { recursive: true });
      const transcriptBytes = Buffer.from('{"session":"mutable","turns":2}');
      writeFileSync(join(transcriptDir, "session-1.json"), transcriptBytes);

      await createBackup(store, archive);
      const freshDir = join(trackTemp("ibkr-restore-transcript-"), "data");
      await restoreBackup(archive, freshDir);
      const restored = readFileSync(
        join(freshDir, "transcripts", "analysis", "session-1.json"),
      );
      expect(restored.equals(transcriptBytes)).toBe(true);
    } finally {
      await dispose();
    }
  });

  it("rejects a corrupted archive with BACKUP_INVALID", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-corrupt-"), "backup.tar");
    try {
      await seedStore(store);
      await createBackup(store, archive);
      // Corrupt bytes inside the manifest payload (not tar zero-padding) so the
      // archive is deterministically invalid regardless of entry alignment.
      const bytes = readFileSync(archive);
      const needle = Buffer.from("ibkr-trade-journal-backup");
      const index = bytes.indexOf(needle);
      expect(index).toBeGreaterThan(-1);
      bytes[index] = (bytes[index] ?? 0) ^ 0xff;
      writeFileSync(archive, bytes);

      const freshDir = join(trackTemp("ibkr-restore-corrupt-"), "data");
      await expect(restoreBackup(archive, freshDir)).rejects.toMatchObject({
        code: "BACKUP_INVALID",
      });
      expect(existsSync(join(freshDir, "journal.sqlite"))).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("rejects a tampered file before replacing the target directory", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-tamper-"), "backup.tar");
    try {
      await seedStore(store);
      await createBackup(store, archive);

      const staging = trackTemp("ibkr-tamper-stage-");
      await new Promise<void>((resolve, reject) => {
        import("tar").then(({ extract }) =>
          extract({ file: archive, cwd: staging }).then(resolve, reject),
        );
      });
      const originalFile = listDirRecursive(join(staging, "originals"))[0];
      expect(originalFile).toBeDefined();
      writeFileSync(originalFile as string, "tampered");
      const tamperedArchive = join(dirname(archive), "tampered.tar");
      await create({ file: tamperedArchive, cwd: staging }, ["."]);

      const targetDir = join(trackTemp("ibkr-restore-tamper-"), "data");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "keep-marker.txt"), "keep");

      await expect(
        restoreBackup(tamperedArchive, targetDir),
      ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      expect(readFileSync(join(targetDir, "keep-marker.txt"), "utf8")).toBe(
        "keep",
      );
    } finally {
      await dispose();
    }
  });

  it("rejects an archive that is missing a referenced original file", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-missing-"), "backup.tar");
    try {
      await seedStore(store);
      await createBackup(store, archive);

      const staging = trackTemp("ibkr-missing-stage-");
      await new Promise<void>((resolve, reject) => {
        import("tar").then(({ extract }) =>
          extract({ file: archive, cwd: staging }).then(resolve, reject),
        );
      });
      const originalFile = listDirRecursive(join(staging, "originals"))[0];
      expect(originalFile).toBeDefined();
      rmSync(originalFile as string);
      const missingArchive = join(dirname(archive), "missing.tar");
      await create({ file: missingArchive, cwd: staging }, ["."]);

      const freshDir = join(trackTemp("ibkr-restore-missing-"), "data");
      await expect(
        restoreBackup(missingArchive, freshDir),
      ).rejects.toMatchObject({
        code: "BACKUP_INVALID",
      });
    } finally {
      await dispose();
    }
  });

  it("rejects a newer schema version before any replacement", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-newer-"), "backup.tar");
    try {
      await seedStore(store);
      await createBackup(store, archive);

      const staging = trackTemp("ibkr-newer-stage-");
      await new Promise<void>((resolve, reject) => {
        import("tar").then(({ extract }) =>
          extract({ file: archive, cwd: staging }).then(resolve, reject),
        );
      });
      const manifestPath = join(staging, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        schemaVersion: number;
      };
      manifest.schemaVersion = manifest.schemaVersion + 1000;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const newerArchive = join(dirname(archive), "newer.tar");
      await create({ file: newerArchive, cwd: staging }, ["."]);

      const targetDir = join(trackTemp("ibkr-restore-newer-"), "data");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "keep-marker.txt"), "keep");
      await expect(
        restoreBackup(newerArchive, targetDir),
      ).rejects.toMatchObject({
        code: "BACKUP_INVALID",
      });
      expect(readFileSync(join(targetDir, "keep-marker.txt"), "utf8")).toBe(
        "keep",
      );
    } finally {
      await dispose();
    }
  });

  it("rejects archive entries with traversal paths and symbolic links", async () => {
    const traversalRoot = trackTemp("ibkr-traversal-");
    const child = join(traversalRoot, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(traversalRoot, "escape.txt"), "escaped");
    const traversalArchive = join(traversalRoot, "traversal.tar");
    await create({ file: traversalArchive, cwd: child, preservePaths: true }, [
      "../escape.txt",
    ]);
    const freshDir = join(trackTemp("ibkr-restore-traversal-"), "data");
    await expect(
      restoreBackup(traversalArchive, freshDir),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });

    const symlinkRoot = trackTemp("ibkr-symlink-");
    symlinkSync("/etc/hostname", join(symlinkRoot, "escape-link"));
    const symlinkArchive = join(symlinkRoot, "symlink.tar");
    await create({ file: symlinkArchive, cwd: symlinkRoot }, ["escape-link"]);
    const symlinkTarget = join(trackTemp("ibkr-restore-symlink-"), "data");
    await expect(
      restoreBackup(symlinkArchive, symlinkTarget),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
  });

  it("refuses to restore over a data directory held by a live lock", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-lock-"), "backup.tar");
    try {
      await seedStore(store);
      await createBackup(store, archive);

      const targetDir = trackTemp("ibkr-locked-");
      const lock = acquireDataDirLock(targetDir);
      try {
        expect(isDataDirLocked(targetDir)).toBe(true);
        await expect(restoreBackup(archive, targetDir)).rejects.toMatchObject({
          code: "DATA_DIR_LOCKED",
        });
      } finally {
        lock.release();
      }
      expect(isDataDirLocked(targetDir)).toBe(false);
    } finally {
      await dispose();
    }
  });

  it("recovers a stale lock left by a crashed process", () => {
    const dir = trackTemp("ibkr-stale-lock-");
    writeFileSync(
      join(dir, "journal.lock"),
      JSON.stringify({ pid: 2 ** 30, startedAt: new Date(0).toISOString() }),
    );
    expect(isDataDirLocked(dir)).toBe(false);
    const lock = acquireDataDirLock(dir);
    try {
      expect(isDataDirLocked(dir)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("makes a pre-restore backup of an existing target directory", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-pre-"), "backup.tar");
    try {
      await seedStore(store);
      await createBackup(store, archive);

      const parent = trackTemp("ibkr-pre-target-");
      const targetDir = join(parent, "data");
      await withFreshStore(targetDir, async (existing) => {
        await commitBytes(existing, "spread.csv", fixtures.spread);
      });

      await restoreBackup(archive, targetDir);
      const siblings = readdirSync(parent);
      const preRestore = siblings.filter((name) =>
        name.startsWith(`${basename(targetDir)}.pre-restore`),
      );
      expect(preRestore.length).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  it("never lets in-flight decisions enter a half snapshot", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-barrier-"), "backup.tar");
    try {
      await appendDecision(
        store,
        notesInput({ strategyId: "s", text: "before" }),
        0,
      );
      expect(decisionWatermark(store)).toBe(1);

      let enterBarrier!: () => void;
      const entered = new Promise<void>((resolve) => {
        enterBarrier = resolve;
      });
      let releaseBarrier!: () => void;
      const barrierGate = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });

      const backupPromise = createBackup(store, archive, {
        beforeSnapshot: async () => {
          enterBarrier();
          await barrierGate;
        },
      });

      await entered;
      const trailing = appendDecision(
        store,
        notesInput({ strategyId: "s", text: "during" }),
        1,
      );
      releaseBarrier();
      const manifest = await backupPromise;
      expect(manifest.decisionWatermark).toBe(1);

      const decision = await trailing;
      expect(decision.sequence).toBe(2);
      expect(decisionWatermark(store)).toBe(2);

      const freshDir = join(trackTemp("ibkr-restore-barrier-"), "data");
      await restoreBackup(archive, freshDir);
      await withFreshStore(freshDir, async (restored) => {
        expect(decisionWatermark(restored)).toBe(1);
        const decisions = readDecisions(restored, 1);
        expect(decisions).toHaveLength(1);
        expect(decisions[0]?.payload).toMatchObject({ text: "before" });
      });
    } finally {
      await dispose();
    }
  });

  it("drains an in-flight write into the snapshot before taking it", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-backup-drain-"), "backup.tar");
    try {
      const pending = appendDecision(
        store,
        notesInput({ strategyId: "s", text: "queued" }),
        0,
      );
      const manifest = await createBackup(store, archive);
      await pending;
      expect(manifest.decisionWatermark).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("does not let a late backup success overwrite a cancelled job", async () => {
    const { store, dispose } = await createTestStore();
    try {
      const jobs = new JobService(store);
      const jobId = await jobs.create("backup", {});
      await jobs.progress(jobId, "snapshotting");
      await jobs.cancel(jobId);
      expect(jobs.read(jobId)?.status).toBe("cancelled");

      const updated = await jobs.finishIfRunning(jobId, "complete");
      expect(updated).toBe(false);
      expect(jobs.read(jobId)?.status).toBe("cancelled");

      const runningId = await jobs.create("backup", {});
      const finished = await jobs.finishIfRunning(runningId, "complete");
      expect(finished).toBe(true);
      expect(jobs.read(runningId)?.status).toBe("complete");
    } finally {
      await dispose();
    }
  });

  it("acquires the data-dir lock at startup and refuses a second instance", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-app-lock-"));
    tempRoots.push(dataDir);
    const first = await createApp(
      readConfig({ DATA_DIR: dataDir, ALLOWED_ORIGIN: ORIGIN }),
    );
    openApps.push(first);
    await expect(
      createApp(readConfig({ DATA_DIR: dataDir, ALLOWED_ORIGIN: ORIGIN })),
    ).rejects.toMatchObject({ code: "DATA_DIR_LOCKED" });
  });

  it("SIGTERM leaves the active build pointer intact and never activates a partial build", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-shutdown-"));
    tempRoots.push(dataDir);
    let enterGate!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const app = await createApp(
      readConfig({ DATA_DIR: dataDir, ALLOWED_ORIGIN: ORIGIN }),
      {
        buildOptions: {
          faults: {
            afterCompute: () => {
              enterGate();
              return gate;
            },
          },
        },
        onReady: (context) => {
          capturedStore = context.store;
        },
      },
    );
    openApps.push(app);

    const buildResponse = await app.inject({
      method: "POST",
      url: "/api/builds",
      headers: { origin: ORIGIN },
      payload: { mode: "full" },
    });
    expect(buildResponse.statusCode).toBe(202);
    const { jobId } = buildResponse.json() as { jobId: string };

    await entered;
    const controller = new AbortController();
    const closing = shutdown(capturedStore as Store, controller.signal);
    releaseGate();
    await closing;

    const journal = await app.inject("/api/journal?pageSize=1");
    expect(journal.statusCode).toBe(200);
    expect((journal.json() as { buildId: string | null }).buildId).toBeNull();

    const jobResponse = await app.inject(`/api/jobs/${jobId}`);
    expect(jobResponse.json()).toMatchObject({
      job: { status: expect.not.stringMatching("complete") },
    });
  });
});

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commitImport,
  type ImportFaults,
  listImports,
  previewImport,
  recoverImportFiles,
} from "../../src/server/imports/service.js";
import type { Store } from "../../src/server/storage/database.js";
import type { Id } from "../../src/shared/domain.js";
import { fixtures } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

const encoder = new TextEncoder();
const INSTANT = "2026-10-13T00:00:00.000Z";
const atInstant = (): Date => new Date(INSTANT);
const afterTtl = (): Date =>
  new Date(Date.parse(INSTANT) + 25 * 60 * 60 * 1000);

const quarantineCsv = encoder.encode(
  [
    "ClientAccountID,AssetClass,Symbol,CurrencyPrimary,DateTime,Quantity,NetCash,Notes/Codes,TradeID,LevelOfDetail",
    "SIM-A,OPT,AXON,USD,2026-09-03 10:00:00,+1,-100,O,TRADE-Q-1,EXECUTION",
    "SIM-A,OPT,AXON,USD,2026-09-03 10:00:00,+1,-100,O,TRADE-Q-2,MYSTERY",
    "SIM-A,OPT,AXON,USD,2026-09-03 10:00:00,+1,-100,,",
  ].join("\n"),
);

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const { store, dispose } = await createTestStore();
  try {
    await run(store);
  } finally {
    await dispose();
  }
}

function readOriginal(store: Store, importId: Id): Uint8Array {
  const row = store.db
    .prepare("SELECT original_file_path FROM imports WHERE id = ?")
    .get(importId) as { original_file_path: string } | undefined;
  if (row === undefined) throw new Error(`Import ${importId} does not exist.`);
  const target = resolve(store.dataDir, row.original_file_path);
  const root = resolve(store.dataDir);
  if (!target.startsWith(root + sep)) {
    throw new Error("Original path escapes the data directory.");
  }
  return new Uint8Array(readFileSync(target));
}

async function errorCode(
  operation: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await operation;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

function crashHooks(points: ReadonlyArray<keyof ImportFaults>): ImportFaults {
  const faults: ImportFaults = {};
  for (const point of points) {
    faults[point] = () => {
      throw new Error(`Simulated crash at ${String(point)}.`);
    };
  }
  return faults;
}

function stagingPath(store: Store, previewId: Id): string {
  return join(store.sourceRoot, ".staging", `${previewId}.part`);
}

function contentPath(store: Store, hash: string): string {
  return join(store.sourceRoot, hash.slice(0, 2), hash);
}

function previewRow(
  store: Store,
  previewId: Id,
): { status: string } | undefined {
  return store.db
    .prepare("SELECT status FROM import_previews WHERE id = ?")
    .get(previewId) as { status: string } | undefined;
}

describe("import preview, original storage, and commit", () => {
  it("exposes issues, capabilities, and counts before confirmation and persists every original row including quarantines", async () =>
    withStore(async (store) => {
      const bytes = quarantineCsv;
      const p = await previewImport(store, {
        filename: "quarantine.csv",
        bytes,
        timezone: "UTC",
      });

      expect(p.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(p.capabilities).toContain("layout:header-first");
      expect(p.counts).toEqual({
        total: 3,
        executions: 1,
        cashTransactions: 0,
        lots: 0,
        summaries: 0,
        markers: 0,
        quarantined: 2,
      });
      expect(p.issues.map((issue) => issue.code)).toEqual([
        "unknown_level_of_detail",
        "unknown_row_type",
      ]);
      expect(p.issues[0]?.key).toBe(`${p.id}:3:unknown_level_of_detail`);
      expect(p.committable).toBe(true);

      expect(listImports(store)).toHaveLength(0);
      const staged = store.db
        .prepare("SELECT COUNT(*) AS count FROM import_rows")
        .get() as { count: number };
      expect(staged.count).toBe(0);

      const first = await commitImport(store, p.id);
      expect(first.duplicate).toBe(false);

      const rows = store.db
        .prepare(
          `SELECT row_number, row_kind, parse_errors_json, raw_fields_json
           FROM import_rows WHERE import_id = ? ORDER BY row_number`,
        )
        .all(first.importId) as Array<{
        row_number: number;
        row_kind: string;
        parse_errors_json: string;
        raw_fields_json: string;
      }>;
      expect(rows.map((row) => row.row_kind)).toEqual([
        "execution",
        "quarantine",
        "quarantine",
      ]);
      expect(rows[1]?.parse_errors_json).toContain("unknown_level_of_detail");
      expect(rows[2]?.parse_errors_json).toContain("unknown_row_type");
      expect(JSON.parse(rows[0]?.raw_fields_json ?? "{}")).toMatchObject({
        TradeID: "TRADE-Q-1",
      });

      const imported = store.db
        .prepare(
          "SELECT capability_json, parser_version FROM imports WHERE id = ?",
        )
        .get(first.importId) as {
        capability_json: string;
        parser_version: string;
      };
      expect(JSON.parse(imported.capability_json)).toMatchObject({
        timezone: "UTC",
      });
      expect(imported.parser_version).toMatch(/^flex-csv/);

      expect(readOriginal(store, first.importId)).toEqual(bytes);
    }));

  it("stores originals at hash-based paths inside the data directory and keeps repeated commits of one preview idempotent", async () =>
    withStore(async (store) => {
      const p = await previewImport(store, {
        filename: "../../escape.csv",
        bytes: fixtures.spread,
        timezone: null,
      });
      const first = await commitImport(store, p.id);
      expect(first.duplicate).toBe(false);
      expect((await commitImport(store, p.id)).importId).toBe(first.importId);
      expect((await commitImport(store, p.id)).duplicate).toBe(true);
      expect(listImports(store)).toHaveLength(1);
      expect(readOriginal(store, first.importId)).toEqual(fixtures.spread);

      const row = store.db
        .prepare(
          "SELECT original_file_path, filename FROM imports WHERE id = ?",
        )
        .get(first.importId) as {
        original_file_path: string;
        filename: string;
      };
      expect(row.original_file_path).toBe(
        `originals/${p.hash.slice(0, 2)}/${p.hash}`,
      );
      expect(existsSync(join(store.dataDir, row.original_file_path))).toBe(
        true,
      );
      expect(row.filename).toBe("../../escape.csv");
    }));

  it("keeps exact-file repeated uploads idempotent across separate previews", async () =>
    withStore(async (store) => {
      const p1 = await previewImport(store, {
        filename: "a.csv",
        bytes: fixtures.spread,
        timezone: null,
      });
      const p2 = await previewImport(store, {
        filename: "b.csv",
        bytes: fixtures.spread,
        timezone: null,
      });
      expect(p2.id).not.toBe(p1.id);
      expect(p2.hash).toBe(p1.hash);

      const r1 = await commitImport(store, p1.id);
      const r2 = await commitImport(store, p2.id);
      expect(r1.duplicate).toBe(false);
      expect(r2.importId).toBe(r1.importId);
      expect(r2.duplicate).toBe(true);
      expect(listImports(store)).toHaveLength(1);
      expect(listImports(store)[0]?.filename).toBe("a.csv");
      expect(listImports(store)[0]?.status).toBe("committed");
      expect((await commitImport(store, p1.id)).importId).toBe(r1.importId);
    }));

  it("keeps staged bytes recoverable when a commit crashes before the durable rename", async () =>
    withStore(async (store) => {
      const p = await previewImport(store, {
        filename: "retry.csv",
        bytes: fixtures.partialFills,
        timezone: null,
      });
      await expect(
        commitImport(store, p.id, { faults: crashHooks(["beforePromote"]) }),
      ).rejects.toThrow(/beforePromote/);

      expect(existsSync(stagingPath(store, p.id))).toBe(true);
      expect(listImports(store)).toHaveLength(0);
      await recoverImportFiles(store);
      expect(existsSync(stagingPath(store, p.id))).toBe(true);

      const first = await commitImport(store, p.id);
      expect(first.duplicate).toBe(false);
      expect((await commitImport(store, p.id)).importId).toBe(first.importId);
      expect(readOriginal(store, first.importId)).toEqual(
        fixtures.partialFills,
      );
      expect(existsSync(stagingPath(store, p.id))).toBe(false);
    }));

  it("keeps a renamed orphan original until its staged preview resolves", async () =>
    withStore(async (store) => {
      const p = await previewImport(store, {
        filename: "roll.csv",
        bytes: fixtures.roll,
        timezone: null,
      });
      await expect(
        commitImport(store, p.id, { faults: crashHooks(["afterPromote"]) }),
      ).rejects.toThrow(/afterPromote/);

      expect(existsSync(contentPath(store, p.hash))).toBe(true);
      expect(listImports(store)).toHaveLength(0);

      await recoverImportFiles(store);
      expect(existsSync(contentPath(store, p.hash))).toBe(true);

      const first = await commitImport(store, p.id);
      expect(first.duplicate).toBe(false);
      expect(listImports(store)).toHaveLength(1);
      expect(readOriginal(store, first.importId)).toEqual(fixtures.roll);
    }));

  it("resumes idempotently when a crash lands after the SQL commit", async () =>
    withStore(async (store) => {
      const p = await previewImport(store, {
        filename: "assignment.csv",
        bytes: fixtures.assignment,
        timezone: null,
      });
      await expect(
        commitImport(store, p.id, {
          faults: crashHooks(["beforeMarkCommitted"]),
        }),
      ).rejects.toThrow(/beforeMarkCommitted/);

      expect(listImports(store)).toHaveLength(1);
      expect(previewRow(store, p.id)).toEqual({ status: "staged" });

      await expect(recoverImportFiles(store)).resolves.toBeUndefined();
      expect(existsSync(contentPath(store, p.hash))).toBe(true);

      const retried = await commitImport(store, p.id);
      expect(retried.duplicate).toBe(true);
      expect(listImports(store)).toHaveLength(1);
      expect(previewRow(store, p.id)).toEqual({ status: "committed" });
      expect(readOriginal(store, retried.importId)).toEqual(
        fixtures.assignment,
      );
    }));

  it("reclaims staging bytes left by a crash during preview staging", async () =>
    withStore(async (store) => {
      await expect(
        previewImport(
          store,
          {
            filename: "crash.csv",
            bytes: fixtures.spread,
            timezone: null,
          },
          { faults: crashHooks(["afterStageWrite"]) },
        ),
      ).rejects.toThrow(/afterStageWrite/);

      const stagingDir = join(store.sourceRoot, ".staging");
      expect(readdirSync(stagingDir)).toHaveLength(1);

      await recoverImportFiles(store);
      expect(readdirSync(stagingDir)).toHaveLength(0);

      const p = await previewImport(store, {
        filename: "crash.csv",
        bytes: fixtures.spread,
        timezone: null,
      });
      const first = await commitImport(store, p.id);
      expect(readOriginal(store, first.importId)).toEqual(fixtures.spread);
    }));

  it("expires uncommitted previews and reclaims their bytes while committed originals never expire", async () =>
    withStore(async (store) => {
      const pA = await previewImport(
        store,
        { filename: "kept.csv", bytes: fixtures.spread, timezone: null },
        { now: atInstant },
      );
      const rA = await commitImport(store, pA.id, { now: atInstant });
      const pB = await previewImport(
        store,
        {
          filename: "staged.csv",
          bytes: fixtures.partialFills,
          timezone: null,
        },
        { now: atInstant },
      );
      expect(existsSync(stagingPath(store, pB.id))).toBe(true);

      const pC = await previewImport(
        store,
        { filename: "orphan.csv", bytes: fixtures.roll, timezone: null },
        { now: atInstant },
      );
      await expect(
        commitImport(store, pC.id, {
          faults: crashHooks(["afterPromote"]),
          now: atInstant,
        }),
      ).rejects.toThrow(/afterPromote/);
      expect(existsSync(contentPath(store, pC.hash))).toBe(true);

      await recoverImportFiles(store, { now: afterTtl });

      expect(previewRow(store, pB.id)).toBeUndefined();
      expect(existsSync(stagingPath(store, pB.id))).toBe(false);
      expect(await errorCode(commitImport(store, pB.id))).toBe(
        "IMPORT_PREVIEW_NOT_FOUND",
      );
      expect(existsSync(contentPath(store, pC.hash))).toBe(false);

      expect(listImports(store)).toHaveLength(1);
      expect(readOriginal(store, rA.importId)).toEqual(fixtures.spread);
      expect(existsSync(contentPath(store, pA.hash))).toBe(true);
    }));

  it("reports a missing committed original as corruption and never removes the import", async () =>
    withStore(async (store) => {
      const p = await previewImport(store, {
        filename: "lost.csv",
        bytes: fixtures.spread,
        timezone: null,
      });
      const first = await commitImport(store, p.id);
      const row = store.db
        .prepare("SELECT original_file_path FROM imports WHERE id = ?")
        .get(first.importId) as { original_file_path: string };
      rmSync(join(store.dataDir, row.original_file_path));

      await expect(recoverImportFiles(store)).rejects.toThrow(/missing/);
      expect(listImports(store)).toHaveLength(1);
      expect(store.db.prepare("SELECT id FROM imports").get()).toMatchObject({
        id: first.importId,
      });
    }));

  it("rejects oversized uploads and commits of fatally unparseable previews", async () =>
    withStore(async (store) => {
      expect(
        await errorCode(
          previewImport(
            store,
            {
              filename: "big.csv",
              bytes: new Uint8Array(64),
              timezone: null,
            },
            { limitBytes: 8 },
          ),
        ),
      ).toBe("IMPORT_TOO_LARGE");

      const binary = new Uint8Array([0xff, 0xfe, 0x20, 0x00]);
      const p = await previewImport(store, {
        filename: "binary.csv",
        bytes: binary,
        timezone: null,
      });
      expect(p.committable).toBe(false);
      expect(p.issues.map((issue) => issue.code)).toContain("invalid_utf8");
      expect(await errorCode(commitImport(store, p.id))).toBe(
        "IMPORT_PREVIEW_NOT_COMMITTABLE",
      );
      expect(listImports(store)).toHaveLength(0);

      const pExpired = await previewImport(
        store,
        { filename: "late.csv", bytes: fixtures.spread, timezone: null },
        { now: atInstant },
      );
      expect(
        await errorCode(commitImport(store, pExpired.id, { now: afterTtl })),
      ).toBe("IMPORT_PREVIEW_EXPIRED");
      await recoverImportFiles(store, { now: afterTtl });
      expect(await errorCode(commitImport(store, pExpired.id))).toBe(
        "IMPORT_PREVIEW_NOT_FOUND",
      );
      expect(existsSync(stagingPath(store, pExpired.id))).toBe(false);
    }));
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeStore,
  openStore,
  write,
} from "../../src/server/storage/database.js";
import { applyMigrations } from "../../src/server/storage/migrations.js";
import { createTestStore } from "../helpers/store.js";

const stores: Array<{
  store: Awaited<ReturnType<typeof openStore>>;
  dataDir: string;
}> = [];

async function openTestStore() {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-journal-storage-"));
  const store = openStore(dataDir);
  stores.push({ store, dataDir });
  return store;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

afterEach(async () => {
  await Promise.all(
    stores.splice(0).map(async ({ store, dataDir }) => {
      await closeStore(store);
      await rm(dataDir, { recursive: true, force: true });
    }),
  );
});

describe("SQLite storage", () => {
  it("opens with foreign keys and WAL and creates the retained schema", async () => {
    const store = await openTestStore();

    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(
      store.db
        .prepare(
          "SELECT type FROM pragma_table_info('strategy_views') WHERE name = 'opening_amount'",
        )
        .get(),
    ).toEqual({ type: "TEXT" });
    expect(tableNames(store.db)).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "accounts",
        "imports",
        "import_rows",
        "ledger_builds",
        "transaction_revisions",
        "transaction_sources",
        "lot_details",
        "strategy_identities",
        "identity_bindings",
        "decisions",
        "jobs",
        "llm_profiles",
        "ai_runs",
        "builds",
        "strategy_views",
        "strategy_allocations",
        "strategy_links",
        "position_views",
        "review_items",
        "import_previews",
        "profile_checks",
        "app_state",
      ]),
    );
  });

  it("rejects an allocation whose build and revision belong to different ledger generations", async () => {
    const store = await openTestStore();
    store.db
      .prepare("INSERT INTO accounts (id, broker_account_id) VALUES (?, ?)")
      .run("account-1", "SIM-1");
    store.db
      .prepare(
        "INSERT INTO ledger_builds (id, input_manifest_hash, parser_version, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "ledger-1",
        "hash-1",
        "parser-1",
        "complete",
        "2026-10-13T00:00:00Z",
      );
    store.db
      .prepare(
        "INSERT INTO ledger_builds (id, input_manifest_hash, parser_version, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "ledger-2",
        "hash-2",
        "parser-1",
        "complete",
        "2026-10-13T00:00:01Z",
      );
    store.db
      .prepare(
        `INSERT INTO transaction_revisions (
          id, ledger_build_id, logical_transaction_key, revision_number, account_id,
          instrument_json, broker_ids_json, event_type, signed_quantity, currency, revision_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "revision-1",
        "ledger-1",
        "logical-1",
        1,
        "account-1",
        "{}",
        "{}",
        "trade",
        "1",
        "USD",
        "active",
      );
    store.db
      .prepare(
        `INSERT INTO builds (
          id, ledger_build_id, decision_watermark, algorithm_version, input_hash, status, validation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("build-1", "ledger-2", 0, "algorithm-1", "hash", "active", "{}");
    store.db
      .prepare(
        "INSERT INTO strategy_identities (id, stable_anchor_key, created_at) VALUES (?, ?, ?)",
      )
      .run("strategy-1", "anchor-1", "2026-10-13T00:00:00Z");
    store.db
      .prepare(
        "INSERT INTO strategy_views (build_id, strategy_id, type, currency, description, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("build-1", "strategy-1", "single", "USD", "test", "open");

    expect(() =>
      store.db
        .prepare(
          `INSERT INTO strategy_allocations (
            build_id, ledger_build_id, strategy_id, revision_id, allocation_role,
            allocated_quantity, allocated_cash
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "build-1",
          "ledger-2",
          "strategy-1",
          "revision-1",
          "open",
          "1",
          "0",
        ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("retains imported evidence and decisions when a projection build is deleted", async () => {
    const store = await openTestStore();
    store.db
      .prepare(
        `INSERT INTO imports (
          id, filename, sha256, original_file_path, imported_at, parser_version, status, capability_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "import-1",
        "statement.csv",
        "sha256",
        "originals/sha256",
        "2026-10-13",
        "parser-1",
        "complete",
        "[]",
      );
    store.db
      .prepare(
        `INSERT INTO import_rows (
          id, import_id, row_number, raw_fields_json, row_kind, parse_errors_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "row-1",
        "import-1",
        1,
        '{"unknown":"retained"}',
        "quarantine",
        "[]",
      );
    store.db
      .prepare(
        `INSERT INTO decisions (
          id, sequence, kind, source_refs_json, strategy_ids_json, payload_json, author, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "decision-1",
        1,
        "metadata_edit",
        "[]",
        "[]",
        "{}",
        "user",
        "2026-10-13",
      );
    store.db
      .prepare(
        `INSERT INTO ledger_builds (id, input_manifest_hash, parser_version, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("ledger-1", "manifest", "parser-1", "complete", "2026-10-13");
    store.db
      .prepare(
        `INSERT INTO builds (
          id, ledger_build_id, decision_watermark, algorithm_version, input_hash, status, validation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("build-1", "ledger-1", 1, "algorithm-1", "input", "active", "{}");

    store.db.prepare("DELETE FROM builds WHERE id = ?").run("build-1");

    expect(
      store.db.prepare("SELECT id FROM import_rows WHERE id = ?").get("row-1"),
    ).toEqual({
      id: "row-1",
    });
    expect(
      store.db
        .prepare("SELECT id FROM decisions WHERE id = ?")
        .get("decision-1"),
    ).toEqual({
      id: "decision-1",
    });
  });

  it("rolls back a failed write and serializes concurrent writes in invocation order", async () => {
    const store = await openTestStore();

    await expect(
      write(store, () => {
        store.db
          .prepare(
            "INSERT INTO jobs (id, kind, input_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run("rolled-back", "test", "{}", "running", "2026-10-13T00:00:00Z");
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect(
      store.db.prepare("SELECT id FROM jobs WHERE id = ?").get("rolled-back"),
    ).toBeUndefined();

    await Promise.all(
      ["first", "second", "third"].map((id) =>
        write(store, () =>
          store.db
            .prepare(
              "INSERT INTO jobs (id, kind, input_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run(id, "test", "{}", "complete", "2026-10-13T00:00:00Z"),
        ),
      ),
    );
    expect(
      store.db
        .prepare("SELECT id FROM jobs ORDER BY rowid")
        .all()
        .map((row) => (row as { id: string }).id),
    ).toEqual(["first", "second", "third"]);

    await expect(write(store, async () => "not allowed")).rejects.toThrow(
      "Storage write callbacks must not return a promise",
    );
  });

  it("persists rows across reopen and refuses a newer schema version", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-journal-reopen-"));
    const first = openStore(dataDir);
    await write(first, () =>
      first.db
        .prepare("INSERT INTO accounts (id, broker_account_id) VALUES (?, ?)")
        .run("persisted", "SIM-PERSISTED"),
    );
    first.db
      .prepare(
        "INSERT INTO jobs (id, kind, input_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("in-flight", "test", "{}", "running", "2026-10-13T00:00:00Z");
    await closeStore(first);

    const reopened = openStore(dataDir);
    stores.push({ store: reopened, dataDir });
    expect(
      reopened.db
        .prepare("SELECT broker_account_id FROM accounts WHERE id = ?")
        .get("persisted"),
    ).toEqual({ broker_account_id: "SIM-PERSISTED" });
    expect(
      reopened.db
        .prepare("SELECT status FROM jobs WHERE id = ?")
        .get("in-flight"),
    ).toEqual({ status: "interrupted" });
    reopened.db
      .prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      )
      .run(999, "2026-10-13T00:00:00Z");
    await closeStore(reopened);
    stores.splice(
      stores.findIndex((entry) => entry.store === reopened),
      1,
    );
    expect(() => openStore(dataDir)).toThrow(/newer than this application/);
    await rm(dataDir, { recursive: true, force: true });
  });

  it("keeps migration reruns idempotent and provides isolated test-store cleanup", async () => {
    const { store, dispose } = await createTestStore();
    try {
      const before = store.db
        .prepare(
          "SELECT version, applied_at FROM schema_migrations ORDER BY version",
        )
        .all();
      applyMigrations(store.db);
      expect(
        store.db
          .prepare(
            "SELECT version, applied_at FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(before);
    } finally {
      await dispose();
    }
  });
});

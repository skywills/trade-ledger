import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

interface Migration {
  version: number;
  url: URL;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: 1, url: new URL("./migrations/001_initial.sql", import.meta.url) },
  {
    version: 2,
    url: new URL("./migrations/002_ledger_issues.sql", import.meta.url),
  },
  {
    version: 3,
    url: new URL("./migrations/003_decision_idempotency.sql", import.meta.url),
  },
  {
    version: 4,
    url: new URL("./migrations/004_build_projection.sql", import.meta.url),
  },
  { version: 5, url: new URL("./migrations/005_chat.sql", import.meta.url) },
];

export const CURRENT_SCHEMA_VERSION =
  MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const latest = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  if ((latest.version ?? 0) > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${latest.version} is newer than this application supports (max ${CURRENT_SCHEMA_VERSION}).`,
    );
  }
  if ((latest.version ?? 0) === CURRENT_SCHEMA_VERSION) return;

  for (const migration of MIGRATIONS) {
    if ((latest.version ?? 0) >= migration.version) continue;
    const sql = readFileSync(fileURLToPath(migration.url), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

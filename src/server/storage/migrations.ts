import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const CURRENT_SCHEMA_VERSION = 1;
const INITIAL_MIGRATION = new URL(
  "./migrations/001_initial.sql",
  import.meta.url,
);

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

  const sql = readFileSync(fileURLToPath(INITIAL_MIGRATION), "utf8");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(CURRENT_SCHEMA_VERSION, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

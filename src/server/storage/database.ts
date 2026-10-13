import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
import { WriterQueue } from "./queue.js";

export interface Store {
  db: Database.Database;
  dataDir: string;
  sourceRoot: string;
  queue: WriterQueue;
  closed: boolean;
}

export function openStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const sourceRoot = join(dataDir, "originals");
  mkdirSync(sourceRoot, { recursive: true });

  const db = new Database(join(dataDir, "journal.sqlite"), { timeout: 5000 });
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    applyMigrations(db);
    db.prepare(
      `UPDATE jobs
       SET status = 'interrupted', error = COALESCE(error, 'Process stopped before the job completed.'),
           finished_at = ?
       WHERE status = 'running'`,
    ).run(new Date().toISOString());
  } catch (error) {
    db.close();
    throw error;
  }

  return { db, dataDir, sourceRoot, queue: new WriterQueue(), closed: false };
}

export async function closeStore(store: Store): Promise<void> {
  if (store.closed) return;
  store.closed = true;
  await store.queue.close();
  store.db.close();
}

export function write<T>(store: Store, operation: () => T): Promise<T> {
  if (store.closed)
    return Promise.reject(new Error("The storage store is closed."));

  const transaction = store.db.transaction(() => {
    const result = operation();
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      throw new Error(
        "Storage write callbacks must not return a promise or hold a transaction across awaits.",
      );
    }
    return result;
  });

  return store.queue.enqueue(() => transaction.immediate());
}

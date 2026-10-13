import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Returns the internal account id for a broker account identifier, creating
 * the retained account row on first sight. Must run inside an open storage
 * write transaction; callers persist ledger revisions in the same transaction
 * so the foreign key target always exists.
 */
export function ensureAccount(
  db: Database.Database,
  brokerAccountId: string,
): string {
  const existing = db
    .prepare("SELECT id FROM accounts WHERE broker_account_id = ?")
    .get(brokerAccountId) as { id: string } | undefined;
  if (existing !== undefined) return existing.id;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO accounts (id, broker_account_id, base_currency) VALUES (?, ?, NULL)",
  ).run(id, brokerAccountId);
  return id;
}

import { createHash, randomUUID } from "node:crypto";
import type { Id } from "../../shared/domain.js";
import { type Store, write } from "../storage/database.js";

export interface StrategyAnchor {
  account: string;
  openingKeys: readonly string[];
}

interface IdentityRow {
  id: string;
}

/**
 * Deterministic anchor for a strategy identity. The strategyId is the UUID
 * registered against this anchor key, and the anchor key is the only durable
 * input to the lookup so two calls with the same account and the same set of
 * opening keys in any order MUST resolve to the same strategy ID.
 */
export function strategyAnchorKey(anchor: StrategyAnchor): string {
  const sortedKeys = [...anchor.openingKeys].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return createHash("sha256")
    .update(`${anchor.account}\u0000${sortedKeys.join("\u0000")}`)
    .digest("hex");
}

/** Reads a previously registered identity without allocating one. */
export function findStrategyId(
  store: Store,
  anchor: StrategyAnchor,
): Id | null {
  const existing = store.db
    .prepare(`SELECT id FROM strategy_identities WHERE stable_anchor_key = ?`)
    .get(strategyAnchorKey(anchor)) as IdentityRow | undefined;
  return existing?.id ?? null;
}

/**
 * Resolves the durable strategy ID for an anchor, allocating a fresh identity
 * the first time the anchor is seen and reusing the existing one across
 * subsequent calls and across ledger generations. Anchors are immutable: once
 * an identity is allocated it is never reissued for a different anchor key.
 */
export async function strategyId(
  store: Store,
  anchor: StrategyAnchor,
): Promise<Id> {
  const anchorKey = strategyAnchorKey(anchor);
  return write(store, () => {
    const existing = findStrategyId(store, anchor);
    if (existing !== null) return existing;
    const id = randomUUID();
    store.db
      .prepare(
        `INSERT INTO strategy_identities (id, stable_anchor_key, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(id, anchorKey, new Date().toISOString());
    return id;
  });
}

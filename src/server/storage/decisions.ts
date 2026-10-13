import { randomUUID } from "node:crypto";
import type { Id, SourceRef } from "../../shared/domain.js";
import { type Store, write } from "./database.js";

export interface DecisionInput {
  kind: string;
  payload: Record<string, unknown>;
  sources?: SourceRef[];
  strategyIds?: Id[];
  author: string;
  supersedesId?: Id | null;
}

export interface RecordedDecision {
  id: Id;
  sequence: number;
}

/**
 * Appends a retained user decision. Sequences are monotonically increasing
 * and assignments happen inside one serialized write so concurrent recorders
 * can never share a sequence. Decisions are immutable; reversal records a new
 * decision that supersedes an earlier one.
 */
export async function recordDecision(
  store: Store,
  input: DecisionInput,
): Promise<RecordedDecision> {
  return write(store, () => {
    const row = store.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM decisions")
      .get() as { sequence: number };
    const sequence = row.sequence + 1;
    const id = randomUUID();
    store.db
      .prepare(
        `INSERT INTO decisions (
           id, sequence, kind, source_refs_json, strategy_ids_json,
           payload_json, author, supersedes_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sequence,
        input.kind,
        JSON.stringify(input.sources ?? []),
        JSON.stringify(input.strategyIds ?? []),
        JSON.stringify(input.payload),
        input.author,
        input.supersedesId ?? null,
        new Date().toISOString(),
      );
    return { id, sequence };
  });
}

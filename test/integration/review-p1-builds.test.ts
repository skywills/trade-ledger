import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  type RebuildInput,
  rebuild,
} from "../../src/server/builds/service.js";
import {
  exclusionInput,
  identityBindingInput,
  notesInput,
  reinclusionInput,
} from "../../src/server/decisions/schemas.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import { registerReviewRoutes } from "../../src/server/http/routes-review.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import { fixtures } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  const { store, dispose } = await createTestStore();
  try {
    await run(store);
  } finally {
    await dispose();
  }
}

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
  return (await commitImport(store, preview.id)).importId;
}

function firstImportSource(store: Store): {
  importId: string;
  rowNumber: number;
} {
  const row = store.db
    .prepare(
      `SELECT import_id AS importId, row_number AS rowNumber
       FROM import_rows ORDER BY import_id, row_number LIMIT 1`,
    )
    .get() as { importId: string; rowNumber: number } | undefined;
  if (row === undefined) throw new Error("No import rows found");
  return row;
}

function insertLegacyDecision(
  store: Store,
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  supersedesId: string | null = null,
): void {
  store.db
    .prepare(
      `INSERT INTO decisions (
         id, sequence, kind, source_refs_json, strategy_ids_json,
         payload_json, author, supersedes_id, created_at, client_request_id
       ) VALUES (?, ?, ?, '[]', '[]', ?, 'test', ?, ?, ?)`,
    )
    .run(
      id,
      decisionWatermark(store) + 1,
      kind,
      JSON.stringify(payload),
      supersedesId,
      new Date().toISOString(),
      `legacy-${id}`,
    );
}

function input(mode: RebuildInput["mode"]): RebuildInput {
  return {
    mode,
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  };
}

async function expectStaleReuseRejected(store: Store, priorBuildId: string) {
  await expect(rebuild(store, input("projection"))).rejects.toMatchObject({
    code: "BUILD_INPUTS_CHANGED",
    message: expect.stringContaining("full rebuild"),
  });
  expect(activeProjection(store).buildId).toBe(priorBuildId);
}

describe("projection rebuild normalization input freshness", () => {
  it("rejects reuse after excluding a committed import", async () =>
    withStore(async (store) => {
      const importId = await commitBytes(store, "spread.csv", fixtures.spread);
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");

      await appendDecision(
        store,
        exclusionInput({ importId }),
        decisionWatermark(store),
      );

      await expectStaleReuseRejected(store, full.id);
    }));

  it("rejects reuse after reincluding an import in the retained ledger", async () =>
    withStore(async (store) => {
      const importId = await commitBytes(store, "spread.csv", fixtures.spread);
      const exclusion = await appendDecision(
        store,
        exclusionInput({ importId }),
        decisionWatermark(store),
      );
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");

      await appendDecision(
        store,
        reinclusionInput({ importId, supersedesId: exclusion.id }),
        decisionWatermark(store),
      );

      await expectStaleReuseRejected(store, full.id);
    }));

  it("honors legacy exclusion aliases when checking reuse", async () =>
    withStore(async (store) => {
      const importId = await commitBytes(store, "spread.csv", fixtures.spread);
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");
      insertLegacyDecision(store, "legacy-exclusion", "exclusion", {
        importId,
      });

      await expectStaleReuseRejected(store, full.id);
    }));

  it("rejects reuse after a new import is committed", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");
      await commitBytes(store, "partial-fills.csv", fixtures.partialFills);

      await expectStaleReuseRejected(store, full.id);
    }));

  it("rejects reuse after an identity binding changes normalization inputs", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");

      await appendDecision(
        store,
        identityBindingInput({
          source: firstImportSource(store),
          canonicalIdentity: "user-selected-transaction",
          expectedQuantity: "1",
        }),
        decisionWatermark(store),
      );

      await expectStaleReuseRejected(store, full.id);
    }));

  it("allows reuse after metadata-only decisions", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");
      const prior = activeProjection(store);
      const strategyId = prior.projection?.strategies[0]?.id;
      if (strategyId === undefined) throw new Error("missing strategy");

      await appendDecision(
        store,
        notesInput({ strategyId, text: "metadata only" }),
        decisionWatermark(store),
      );

      const projected = await rebuild(store, input("projection"));
      expect(projected.status).toBe("active");
      expect(activeProjection(store).buildId).toBe(projected.id);
    }));

  it("allows metadata-only reuse when the full build retained an exclusion", async () =>
    withStore(async (store) => {
      const importId = await commitBytes(store, "spread.csv", fixtures.spread);
      await appendDecision(
        store,
        exclusionInput({ importId }),
        decisionWatermark(store),
      );
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");

      await appendDecision(
        store,
        notesInput({ strategyId: "metadata-only", text: "kept" }),
        decisionWatermark(store),
      );
      const projected = await rebuild(store, input("projection"));

      expect(projected.status).toBe("active");
      expect(activeProjection(store).buildId).toBe(projected.id);
      expect(activeProjection(store).projection?.strategies).toEqual([]);
    }));

  it("does not activate a projection candidate changed during computation", async () =>
    withStore(async (store) => {
      const importId = await commitBytes(store, "spread.csv", fixtures.spread);
      const full = await rebuild(store, input("full"));
      expect(full.status).toBe("active");

      const candidate = await rebuild(store, input("projection"), {
        faults: {
          afterCompute: async () => {
            await appendDecision(
              store,
              exclusionInput({ importId }),
              decisionWatermark(store),
            );
          },
        },
      });

      expect(candidate.status).toBe("stale");
      expect(activeProjection(store).buildId).toBe(full.id);
      expect(
        store.db
          .prepare("SELECT status FROM builds WHERE id = ?")
          .get(candidate.id),
      ).toEqual({ status: "stale" });
    }));
});

it("groups equivalent findings before review pagination", async () =>
  withStore(async (store) => {
    const build = await rebuild(store, input("full"));
    const insert = store.db.prepare(
      `INSERT INTO review_items (build_id, stable_issue_key, reason, source_references_json, candidate_json, severity) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [key, kind, executionKey] of [
      ["strategy:a", "strategy", "a"],
      ["lifecycle:a", "lifecycle", "a"],
      ["strategy:b", "strategy", "b"],
      ["lifecycle:b", "lifecycle", "b"],
    ]) {
      const reconciliation = {
        version: 1,
        owners: [{ kind, id: key }],
        slices: [{ executionKey, role: "open", quantity: "1", netCash: "2" }],
        currency: "USD",
        brokerPnl: "1",
        reconstructedPnl: "2",
      };
      insert.run(
        build.id,
        key,
        "PNL_RECONCILIATION",
        "[]",
        JSON.stringify({ reconciliation }),
        "warning",
      );
    }
    const app = Fastify();
    try {
      await registerReviewRoutes(app, store);
      const first = (await app.inject("/api/review?pageSize=1&page=1")).json();
      const second = (await app.inject("/api/review?pageSize=1&page=2")).json();
      expect(first.total).toBe(2);
      expect(second.total).toBe(2);
      expect(first.items[0].key).not.toBe(second.items[0].key);
      expect(first.items[0].issueKeys).toHaveLength(2);
      expect(second.items[0].issueKeys).toHaveLength(2);
    } finally {
      await app.close();
    }
  }));

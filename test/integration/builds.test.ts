import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ALGORITHM_VERSION,
  activeProjection,
  BuildScheduler,
  computeProjection,
  type RebuildInput,
  rebuild,
  recoverBuilds,
  rollbackBuild,
} from "../../src/server/builds/service.js";
import {
  strategyAnchorKey,
  strategyId,
} from "../../src/server/decisions/registry.js";
import {
  manualAllocationInput,
  notesInput,
  rejectionInput,
} from "../../src/server/decisions/schemas.js";
import {
  appendDecision,
  decisionWatermark,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  LEDGER_PARSER_VERSION,
  normalizeLedger,
  readLedger,
} from "../../src/server/ledger/normalize.js";
import type { Store } from "../../src/server/storage/database.js";
import { accountProjection } from "../../src/server/strategies/accounting.js";
import { groupStrategies } from "../../src/server/strategies/grouping.js";
import type { Projection } from "../../src/shared/domain.js";
import {
  buildExecutionTable,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";
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
  const committed = await commitImport(store, preview.id);
  expect(committed.duplicate).toBe(false);
  return committed.importId;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function input(
  mode: RebuildInput["mode"],
  overrides: Partial<RebuildInput> = {},
): RebuildInput {
  return {
    mode,
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: signal(),
    ...overrides,
  };
}

function count(store: Store, table: string): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}

function activeLedgerId(store: Store): string {
  const row = store.db
    .prepare(
      `SELECT b.ledger_build_id AS id FROM app_state s
       JOIN builds b ON b.id = s.active_build_id
       WHERE s.singleton = 1`,
    )
    .get() as { id: string } | undefined;
  if (row === undefined) throw new Error("no active ledger build");
  return row.id;
}

function firstImportRow(store: Store): {
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

function firstExecutionKey(store: Store): string {
  const ledger = readLedger(store, activeLedgerId(store));
  const execution = ledger.executions[0];
  if (execution === undefined) throw new Error("no executions in ledger");
  return execution.key;
}

/** Order-insensitive canonical rendering of a projection for equality checks. */
function canonical(projection: Projection): string {
  const strategies = [...projection.strategies]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((strategy) => ({
      ...strategy,
      positions: [...strategy.positions].sort((a, b) =>
        a.instrumentKey < b.instrumentKey ? -1 : 1,
      ),
      reasons: [...strategy.reasons].sort(),
    }));
  const allocations = [...projection.allocations].sort((a, b) =>
    `${a.strategyId}|${a.executionKey}` < `${b.strategyId}|${b.executionKey}`
      ? -1
      : 1,
  );
  const links = [...projection.links].sort((a, b) =>
    `${a.from}|${a.to}|${a.type}` < `${b.from}|${b.to}|${b.type}` ? -1 : 1,
  );
  const issues = [...projection.issues].sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );
  return JSON.stringify({
    ledgerId: projection.ledgerId,
    watermark: projection.watermark,
    strategies,
    allocations,
    links,
    issues,
  });
}

describe("versioned builds, atomic activation and rollback", () => {
  it("rejects unavailable versions without disturbing the active build", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const first = await rebuild(store, input("full"));
      expect(first.status).toBe("active");
      const original = activeProjection(store).buildId;

      await expect(
        rebuild(store, input("full", { parserVersion: "flex-v2" })),
      ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
      expect(activeProjection(store).buildId).toBe(original);

      await expect(
        rebuild(store, input("full", { algorithmVersion: "strategies-v9" })),
      ).rejects.toMatchObject({ code: "VERSION_UNAVAILABLE" });
      expect(activeProjection(store).buildId).toBe(original);
    }));

  it("cancels a build before it activates anything", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const original = activeProjection(store).buildId;

      const controller = new AbortController();
      controller.abort();
      const cancelled = await rebuild(
        store,
        input("full", { signal: controller.signal }),
      );
      expect(cancelled.status).toBe("cancelled");
      // A cancelled build is persisted: the returned id resolves to a real row.
      const row = store.db
        .prepare("SELECT status FROM builds WHERE id = ?")
        .get(cancelled.id) as { status: string } | undefined;
      expect(row).toMatchObject({ status: "cancelled" });
      expect(activeProjection(store).buildId).toBe(original);
    }));

  it("does not activate a candidate whose inputs changed before activation", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const original = activeProjection(store).buildId;

      const staleCandidate = await rebuild(store, input("full"), {
        faults: {
          afterCompute: async () => {
            await appendDecision(
              store,
              notesInput({ strategyId: "mid-build", text: "changed" }),
              decisionWatermark(store),
            );
          },
        },
      });

      expect(staleCandidate.status).toBe("stale");
      expect(activeProjection(store).buildId).toBe(original);
    }));

  it("persists a full projection and reconstructs it field for field", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const result = await rebuild(store, input("full"));
      const active = activeProjection(store);
      expect(active.buildId).toBe(result.id);
      expect(active.projection).not.toBeNull();

      const projection = active.projection;
      if (projection === null) throw new Error("missing projection");
      const ledger = readLedger(store, projection.ledgerId);
      const computed = await computeProjection(
        store,
        ledger,
        projection.watermark,
      );
      expect(canonical(projection)).toBe(canonical(computed));

      const strategy = projection.strategies.find(
        (entry) => entry.type === "bull_put_spread",
      );
      expect(strategy?.brokerPnl).toBe("-451.660745");
      expect(strategy?.reconstructedPnl).toBe("-451.6607454");
      expect(strategy?.cashflow).toBe("-451.6607454");
      expect(strategy?.openingAmount).toBe("-284.5018378");
    }));

  it("reuses the retained generation for projection rebuilds with equal content", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const full = activeProjection(store).projection;
      if (full === null) throw new Error("missing full projection");

      const projected = await rebuild(store, input("projection"));
      expect(projected.status).toBe("active");
      const projectionMode = activeProjection(store).projection;
      if (projectionMode === null) throw new Error("missing projection build");

      expect(projectionMode.ledgerId).toBe(full.ledgerId);
      expect(canonical(projectionMode)).toBe(canonical(full));
    }));

  it("reuses the same strategy identities across two full rebuilds", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const firstProjection = activeProjection(store).projection;
      if (firstProjection === null) throw new Error("missing projection");
      const firstIds = firstProjection.strategies
        .map((strategy) => strategy.id)
        .sort();
      const identitiesAfterFirst = count(store, "strategy_identities");
      expect(firstIds.length).toBeGreaterThan(0);

      await rebuild(store, input("full"));
      const secondProjection = activeProjection(store).projection;
      if (secondProjection === null) throw new Error("missing projection");
      const secondIds = secondProjection.strategies
        .map((strategy) => strategy.id)
        .sort();

      expect(secondIds).toEqual(firstIds);
      expect(count(store, "strategy_identities")).toBe(identitiesAfterFirst);
    }));

  it("retains notes, rejections and identity bindings when derived rows are deleted", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const watermark = decisionWatermark(store);
      await appendDecision(
        store,
        notesInput({ strategyId: "strategy-notes", text: "kept" }),
        watermark,
      );
      await appendDecision(
        store,
        rejectionInput({ evidenceHash: "abc123", reason: "stale proposal" }),
        watermark + 1,
      );
      const identity = await strategyId(store, {
        account: "SIM-A",
        openingKeys: ["txn:SIM-A:trade:TRADE-A-1"],
      });
      store.db
        .prepare(
          `INSERT INTO identity_bindings (
             id, source_reference_json, logical_reference,
             canonical_identity_id, decision_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "binding-1",
          "{}",
          "logical-ref",
          identity,
          null,
          new Date().toISOString(),
        );

      const decisionsBefore = count(store, "decisions");
      const bindingsBefore = count(store, "identity_bindings");
      const identitiesBefore = count(store, "strategy_identities");
      const importsBefore = count(store, "imports");

      store.db
        .prepare(
          "UPDATE app_state SET active_build_id = NULL WHERE singleton = 1",
        )
        .run();
      store.db.prepare("DELETE FROM builds").run();
      store.db.prepare("DELETE FROM transaction_sources").run();
      store.db.prepare("DELETE FROM lot_details").run();
      store.db.prepare("DELETE FROM ledger_issues").run();
      store.db.prepare("DELETE FROM transaction_revisions").run();
      store.db.prepare("DELETE FROM ledger_builds").run();

      expect(count(store, "decisions")).toBe(decisionsBefore);
      expect(count(store, "identity_bindings")).toBe(bindingsBefore);
      expect(count(store, "strategy_identities")).toBe(identitiesBefore);
      expect(count(store, "imports")).toBe(importsBefore);
    }));

  it("refuses to activate a candidate with a hard invariant failure", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const original = activeProjection(store).buildId;

      await appendDecision(
        store,
        manualAllocationInput({
          strategyId: "over-allocated",
          source: firstImportRow(store),
          allocations: [
            {
              executionKey: firstExecutionKey(store),
              quantity: "5",
              netCash: "-100",
              brokerPnl: null,
            },
          ],
        }),
        decisionWatermark(store),
      );

      const failed = await rebuild(store, input("full"));
      expect(failed.status).toBe("failed");
      expect(failed.issues.some((issue) => issue.severity === "error")).toBe(
        true,
      );
      expect(activeProjection(store).buildId).toBe(original);
    }));

  it("activates a candidate that carries only completeness warnings", async () =>
    withStore(async (store) => {
      const rows = buildExecutionTable([
        executionRow({
          ClientAccountID: "SIM-W",
          AssetClass: "OPT",
          Symbol: "WARN",
          UnderlyingSymbol: "WARN",
          Conid: "9300001",
          CurrencyPrimary: "USD",
          TradeDate: "2026-09-25",
          DateTime: "2026-09-25 11:00:00",
          Quantity: "-1",
          TradePrice: "3",
          NetCash: "300",
          "Notes/Codes": "C",
          IBOrderID: "CLOSE-ONLY",
          BrokerageOrderID: "CLOSE-ONLY",
          IBExecID: "EXEC-W-1",
          TradeID: "TRADE-W-1",
          Expiry: "2026-10-16",
          Strike: "100",
          "Put/Call": "P",
          Multiplier: "100",
        }),
      ]);
      await commitBytes(store, "close-only.csv", rows);
      const result = await rebuild(store, input("full"));
      expect(result.status).toBe("active");
      const projection = activeProjection(store).projection;
      if (projection === null) throw new Error("missing projection");
      expect(projection.issues.map((issue) => issue.code)).toContain(
        "MISSING_OPENING",
      );
    }));

  it("starts from an empty state and activates an empty first generation", async () =>
    withStore(async (store) => {
      expect(activeProjection(store)).toEqual({
        buildId: null,
        stale: false,
        projection: null,
      });

      const result = await rebuild(store, input("full"));
      expect(result.status).toBe("active");
      const active = activeProjection(store);
      expect(active.buildId).toBe(result.id);
      expect(active.stale).toBe(false);
      expect(active.projection?.strategies).toEqual([]);
      expect(active.projection?.allocations).toEqual([]);
      expect(active.projection?.links).toEqual([]);
    }));

  it("marks an interrupted candidate failed and never active on recovery", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      store.db
        .prepare(
          `INSERT INTO builds (
             id, ledger_build_id, decision_watermark, algorithm_version,
             input_hash, status, validation_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "interrupted-build",
          activeLedgerId(store),
          0,
          ALGORITHM_VERSION,
          "interrupted-hash",
          "running",
          "[]",
        );

      await recoverBuilds(store);
      expect(
        store.db
          .prepare("SELECT status FROM builds WHERE id = ?")
          .get("interrupted-build"),
      ).toEqual({ status: "failed" });
      expect(activeProjection(store).buildId).not.toBe("interrupted-build");
    }));

  it("rolls back to a retained generation and marks it stale when inputs differ", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const first = await rebuild(store, input("full"));
      await appendDecision(
        store,
        notesInput({ strategyId: "later", text: "later decision" }),
        decisionWatermark(store),
      );
      const second = await rebuild(store, input("full"));
      expect(activeProjection(store).buildId).toBe(second.id);

      await rollbackBuild(store, first.id);
      const rolledBack = activeProjection(store);
      expect(rolledBack.buildId).toBe(first.id);
      expect(rolledBack.stale).toBe(true);
      expect(
        store.db
          .prepare("SELECT status FROM builds WHERE id = ?")
          .get(first.id),
      ).toEqual({ status: "stale" });

      await rollbackBuild(store, second.id);
      const restored = activeProjection(store);
      expect(restored.buildId).toBe(second.id);
      expect(restored.stale).toBe(false);

      expect(count(store, "decisions")).toBe(1);
      expect(count(store, "imports")).toBe(1);
    }));

  it("rejects a projection rebuild when the retained ledger version is unavailable", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const original = activeProjection(store).buildId;

      store.db
        .prepare(
          "UPDATE ledger_builds SET parser_version = 'legacy-v0' WHERE id = ?",
        )
        .run(activeLedgerId(store));

      await expect(rebuild(store, input("projection"))).rejects.toMatchObject({
        code: "VERSION_UNAVAILABLE",
      });
      expect(activeProjection(store).buildId).toBe(original);
    }));

  it("performs no AI or network activity during a rebuild", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const originalFetch = globalThis.fetch;
      let networkCalls = 0;
      globalThis.fetch = (async () => {
        networkCalls += 1;
        throw new Error("network disabled during rebuild");
      }) as typeof fetch;
      try {
        const result = await rebuild(store, input("full"));
        expect(result.status).toBe("active");
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(networkCalls).toBe(0);
      expect(count(store, "ai_runs")).toBe(0);
    }));

  it("coalesces closely spaced rebuild requests into one job", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const scheduler = new BuildScheduler(store);
      const ledgerBuildsBefore = count(store, "ledger_builds");
      const jobsBefore = count(store, "jobs");

      const results = await Promise.all([
        scheduler.request(input("full")),
        scheduler.request(input("full")),
        scheduler.request(input("projection")),
      ]);

      expect(results[0]?.id).toBe(results[1]?.id);
      expect(results[1]?.id).toBe(results[2]?.id);
      expect(results[0]?.status).toBe("active");
      expect(count(store, "ledger_builds")).toBe(ledgerBuildsBefore + 1);
      expect(count(store, "jobs")).toBe(jobsBefore + 1);

      const job = store.db
        .prepare(
          "SELECT status, progress FROM jobs ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { status: string; progress: string | null };
      expect(job.status).toBe("complete");
      expect(job.progress).not.toBeNull();
    }));

  it("rejects rolling back to a failed candidate", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      store.db
        .prepare(
          `INSERT INTO builds (
             id, ledger_build_id, decision_watermark, algorithm_version,
             input_hash, status, validation_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "failed-build",
          activeLedgerId(store),
          0,
          ALGORITHM_VERSION,
          "hash",
          "failed",
          "[]",
        );
      const randomId = randomUUID();
      await expect(rollbackBuild(store, randomId)).rejects.toMatchObject({
        code: "BUILD_NOT_FOUND",
      });
      await expect(rollbackBuild(store, "failed-build")).rejects.toMatchObject({
        code: "BUILD_NOT_ROLLBACKABLE",
      });
    }));

  it("surfaces duplicate manual allocations as a review item instead of failing the build", async () =>
    withStore(async (store) => {
      await commitBytes(
        store,
        "single.csv",
        buildExecutionTable([
          executionRow({
            ClientAccountID: "SIM-DUP",
            AssetClass: "OPT",
            Symbol: "DUP",
            UnderlyingSymbol: "DUP",
            Conid: "9800001",
            CurrencyPrimary: "USD",
            TradeDate: "2026-09-03",
            DateTime: "2026-09-03 10:00:00",
            Quantity: "+1",
            TradePrice: "14.02",
            NetCash: "-1402.23006",
            "Notes/Codes": "O",
            IBOrderID: "DUP-OPEN",
            BrokerageOrderID: "DUP-OPEN",
            IBExecID: "EXEC-DUP-1",
            TradeID: "TRADE-DUP-1",
            Expiry: "2026-10-16",
            Strike: "470",
            "Put/Call": "P",
            Multiplier: "100",
          }),
        ]),
      );
      await rebuild(store, input("full"));
      const source = firstImportRow(store);
      const executionKey = firstExecutionKey(store);
      const watermark = decisionWatermark(store);

      const allocation = {
        executionKey,
        quantity: "1",
        netCash: "-1402.23006",
        brokerPnl: null,
      };
      await appendDecision(
        store,
        manualAllocationInput({
          strategyId: "dup-strategy",
          source,
          allocations: [allocation],
        }),
        watermark,
      );
      await appendDecision(
        store,
        manualAllocationInput({
          strategyId: "dup-strategy",
          source,
          allocations: [allocation],
        }),
        watermark + 1,
      );

      const built = await rebuild(store, input("full"));
      expect(built.status).toBe("active");
      const projection = activeProjection(store).projection;
      expect(projection?.issues.map((issue) => issue.code)).toContain(
        "DUPLICATE_ALLOCATION",
      );
    }));

  it("writes broker P/L to broker_pnl and leaves the legacy realized_pnl column unset", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, input("full"));
      const buildId = activeProjection(store).buildId;
      const rows = store.db
        .prepare(
          `SELECT broker_pnl, reconstructed_pnl, realized_pnl, remaining_exposure
           FROM strategy_views WHERE build_id = ?`,
        )
        .all(buildId) as Array<{
        broker_pnl: string | null;
        reconstructed_pnl: string | null;
        realized_pnl: string | null;
        remaining_exposure: string | null;
      }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((row) => row.broker_pnl !== null)).toBe(true);
      expect(rows.every((row) => row.realized_pnl === null)).toBe(true);
      expect(rows.every((row) => row.remaining_exposure === null)).toBe(true);
    }));
});

// A small guard that the pure grouping path still produces the same anchors the
// registry-backed build path does; keeps the provisional-id contract honest.
describe("provisional identity wiring", () => {
  it("uses anchor keys that resolve to stable durable strategy ids", async () =>
    withStore(async (store) => {
      await commitBytes(store, "spread.csv", fixtures.spread);
      const ledger = await normalizeLedger(store, {
        parserVersion: LEDGER_PARSER_VERSION,
        decisionWatermark: 0,
      });
      const anchors = new Map<
        string,
        { account: string; openingKeys: string[] }
      >();
      const resolveId = (account: string, keys: string[]): string => {
        const key = strategyAnchorKey({ account, openingKeys: keys });
        anchors.set(key, { account, openingKeys: [...keys] });
        return key;
      };
      const projection = accountProjection(
        ledger,
        groupStrategies(ledger, [], resolveId),
      );
      const remap = new Map<string, string>();
      for (const [key, anchor] of anchors) {
        remap.set(key, await strategyId(store, anchor));
      }
      const remapped = projection.strategies.map(
        (strategy) => remap.get(strategy.id) ?? strategy.id,
      );
      expect(remapped.every((id) => id !== undefined)).toBe(true);
      expect(remapped.some((id) => anchors.has(id))).toBe(false);
    }));
});

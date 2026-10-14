import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testProfile } from "../../src/server/ai/compatibility.js";
import {
  type ProfileInput,
  saveProfile,
  snapshotProfile,
} from "../../src/server/ai/profiles.js";
import { createApp } from "../../src/server/app.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { readConfig } from "../../src/server/config.js";
import {
  exclusionInput,
  notesInput,
  rejectionInput,
  stopLossInput,
} from "../../src/server/decisions/schemas.js";
import {
  appendDecision,
  decisionWatermark,
  readDecisions,
} from "../../src/server/decisions/service.js";
import {
  commitImport,
  listImports,
  previewImport,
} from "../../src/server/imports/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import { createBackup } from "../../src/server/maintenance/backup.js";
import {
  acquireDataDirLock,
  isDataDirLocked,
} from "../../src/server/maintenance/lock.js";
import { restoreBackup } from "../../src/server/maintenance/restore.js";
import { shutdown } from "../../src/server/maintenance/shutdown.js";
import {
  closeStore,
  openStore,
  type Store,
} from "../../src/server/storage/database.js";
import type { Projection } from "../../src/shared/domain.js";
import {
  buildExecutionTable,
  executionRow,
  fixtures,
} from "../fixtures/scenarios.js";
import {
  type InferenceServer,
  startInferenceServer,
} from "../helpers/inference-server.js";
import { createTestStore } from "../helpers/store.js";

const ORIGIN = "http://localhost:3000";

const tempRoots: string[] = [];
const openApps: Array<{ close: () => Promise<void> }> = [];
const inferenceServers: InferenceServer[] = [];
let capturedStore: Store | undefined;

function trackTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(inferenceServers.splice(0).map((server) => server.close()));
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

function rebuildInput() {
  return {
    mode: "full" as const,
    parserVersion: LEDGER_PARSER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    signal: signal(),
  };
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

/** Scenario D formatting oracle: a 2026 opening for a 2027 expiry plus a stock. */
function scenarioD(): Uint8Array {
  return buildExecutionTable([
    executionRow({
      ClientAccountID: "SIM-D",
      AssetClass: "OPT",
      Symbol: "DOPT",
      UnderlyingSymbol: "DOPT",
      Conid: "9500001",
      CurrencyPrimary: "USD",
      TradeDate: "2026-09-03",
      DateTime: "2026-09-03 10:00:00",
      Quantity: "+1",
      TradePrice: "4.223592",
      NetCash: "-422.3592",
      "Notes/Codes": "O",
      IBOrderID: "D-OPEN",
      BrokerageOrderID: "D-OPEN",
      IBExecID: "EXEC-D-1",
      TradeID: "TRADE-D-1",
      Expiry: "2027-01-15",
      Strike: "100",
      "Put/Call": "C",
      Multiplier: "100",
    }),
    executionRow({
      ClientAccountID: "SIM-D",
      AssetClass: "STK",
      Symbol: "DSTK",
      UnderlyingSymbol: "DSTK",
      Conid: "9500002",
      CurrencyPrimary: "USD",
      TradeDate: "2026-09-03",
      DateTime: "2026-09-03 10:00:00",
      Quantity: "+100",
      TradePrice: "10.123456789",
      NetCash: "-1012.3456789",
      "Notes/Codes": "O",
      IBOrderID: "D-STK",
      BrokerageOrderID: "D-STK",
      IBExecID: "EXEC-D-2",
      TradeID: "TRADE-D-2",
      Multiplier: "1",
    }),
  ]);
}

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
  return JSON.stringify({ strategies, allocations, links, issues });
}

function deleteDerived(store: Store): void {
  store.db
    .prepare("UPDATE app_state SET active_build_id = NULL WHERE singleton = 1")
    .run();
  store.db.prepare("DELETE FROM builds").run();
  store.db.prepare("DELETE FROM transaction_sources").run();
  store.db.prepare("DELETE FROM lot_details").run();
  store.db.prepare("DELETE FROM ledger_issues").run();
  store.db.prepare("DELETE FROM transaction_revisions").run();
  store.db.prepare("DELETE FROM ledger_builds").run();
}

function profileInput(endpoint: string): ProfileInput {
  return {
    name: "acceptance-local",
    mode: "local",
    provider: "openai",
    protocol: "openai-completions",
    endpoint,
    modelId: "test-local-a",
    contextWindow: 8192,
    maxTokens: 1024,
    timeoutSeconds: 10,
    supportsTools: true,
    thinkingLevels: ["off"],
    credentialRef: null,
  };
}

describe("final acceptance: scenarios A-D survive rebuild, backup and restore", () => {
  it("reconstructs scenarios A-D, survives a full re-normalization, and keeps decisions", async () => {
    const { store, dispose } = await createTestStore();
    try {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await commitBytes(store, "assignment.csv", fixtures.assignment);
      await commitBytes(store, "partial-fills.csv", fixtures.partialFills);
      await commitBytes(store, "roll.csv", fixtures.roll);
      await commitBytes(store, "formatting.csv", scenarioD());
      expect(listImports(store)).toHaveLength(5);

      await rebuild(store, rebuildInput());

      const first = activeProjection(store).projection;
      if (first === null) throw new Error("missing first projection");
      const spread = first.strategies.find(
        (strategy) => strategy.type === "bull_put_spread",
      );
      expect(spread?.openingAmount).toBe("-284.5018378");
      expect(spread?.cashflow).toBe("-451.6607454");
      expect(spread?.brokerPnl).toBe("-451.660745");
      expect(spread?.closeDate).toBe("2026-09-25");
      expect(first.issues.map((issue) => issue.code)).toContain(
        "MISSING_OPENING",
      );

      // Decisions are appended after the first build, then must survive a
      // deletion of every derived row and a full re-normalization.
      const spreadId = spread?.id ?? "";
      await appendDecision(
        store,
        notesInput({ strategyId: spreadId, text: "Held through earnings" }),
        decisionWatermark(store),
      );
      await appendDecision(
        store,
        stopLossInput({ strategyId: spreadId, price: "1.25" }),
        decisionWatermark(store),
      );
      const bImport = listImports(store).find((entry) =>
        entry.filename.includes("assignment"),
      );
      if (bImport === undefined) throw new Error("missing assignment import");
      await appendDecision(
        store,
        exclusionInput({ importId: bImport.id }),
        decisionWatermark(store),
      );
      await appendDecision(
        store,
        rejectionInput({ evidenceHash: "abc123", reason: "stale proposal" }),
        decisionWatermark(store),
      );

      await rebuild(store, rebuildInput());
      const before = activeProjection(store).projection;
      if (before === null) throw new Error("missing second projection");
      const decisionsBefore = readDecisions(store, decisionWatermark(store));
      expect(decisionsBefore.map((decision) => decision.kind)).toEqual([
        "notes",
        "stop_loss",
        "exclusion",
        "rejection",
      ]);

      deleteDerived(store);
      await rebuild(store, rebuildInput());

      const after = activeProjection(store).projection;
      if (after === null) throw new Error("missing rebuilt projection");
      // Deleting and recreating normalization preserves every financial amount,
      // allocation, link and issue; only generation identifiers differ.
      expect(canonical(after)).toBe(canonical(before));
      expect(readDecisions(store, decisionWatermark(store))).toEqual(
        decisionsBefore,
      );
      expect(listImports(store)).toHaveLength(5);

      // Scenario D: source decimals reconcile and a 2026 opening for a 2027
      // expiry reports the contract year while a stock reports none.
      const dOption = after.strategies.find((strategy) =>
        strategy.description.includes("DOPT"),
      );
      expect(dOption?.expiryYear).toBe(2027);
      expect(dOption?.cashflow).toBe("-422.3592");
      const dStock = after.strategies.find((strategy) =>
        strategy.description.includes("DSTK"),
      );
      expect(dStock?.expiryYear).toBeNull();
      expect(dStock?.cashflow).toBe("-1012.3456789");
    } finally {
      await dispose();
    }
  });

  it("roundtrips the journal through backup and restore", async () => {
    const { store, dispose } = await createTestStore();
    const archive = join(trackTemp("ibkr-accept-backup-"), "backup.tar");
    try {
      await commitBytes(store, "spread.csv", fixtures.spread);
      await rebuild(store, rebuildInput());
      await appendDecision(
        store,
        notesInput({ strategyId: "acceptance", text: "kept across restore" }),
        decisionWatermark(store),
      );

      const original = activeProjection(store).projection;
      const watermark = decisionWatermark(store);
      await createBackup(store, archive);

      const freshDir = join(trackTemp("ibkr-accept-restore-"), "data");
      await restoreBackup(archive, freshDir);
      const restored = openStore(freshDir);
      try {
        expect(decisionWatermark(restored)).toBe(watermark);
        expect(activeProjection(restored).projection).toEqual(original);
        expect(listImports(restored)).toHaveLength(1);
      } finally {
        await closeStore(restored);
      }
    } finally {
      await dispose();
    }
  });

  it("verifies a local profile against the synthetic server and keeps readiness independent of it", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-accept-models-"));
    tempRoots.push(dataDir);
    const inference = await startInferenceServer({ mode: "tool-call" });
    inferenceServers.push(inference);

    const app = await createApp(
      readConfig({
        DATA_DIR: dataDir,
        ALLOWED_ORIGIN: ORIGIN,
        NODE_ENV: "test",
      }),
      {
        onReady: (context) => {
          capturedStore = context.store;
        },
      },
    );
    openApps.push(app);

    // Readiness must answer before any model is reachable or configured.
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);

    const profile = await saveProfile(
      capturedStore as Store,
      profileInput(inference.url),
      null,
    );
    expect(snapshotProfile(capturedStore as Store, profile.id).modelId).toBe(
      "test-local-a",
    );
    expect(
      (await testProfile(capturedStore as Store, profile.id, signal())).status,
    ).toBe("verified");

    // With the inference server stopped, readiness is unaffected: no model
    // service is required for the journal to be ready.
    await inference.close();
    inferenceServers.splice(inferenceServers.indexOf(inference), 1);
    const afterStop = await app.inject({ method: "GET", url: "/health/ready" });
    expect(afterStop.statusCode).toBe(200);
  });

  it("defaults production static serving to the compiled web bundle", () => {
    const config = readConfig({
      DATA_DIR: "/tmp/ibkr-production-default",
      NODE_ENV: "production",
      ALLOWED_ORIGIN: ORIGIN,
    });
    expect(config.staticDir).toBe(resolve("dist/web"));
  });

  it("serves production SPA deep links and keeps unknown API routes as JSON", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-accept-web-"));
    tempRoots.push(dataDir);
    const webDir = trackTemp("ibkr-accept-static-");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(
      join(webDir, "index.html"),
      '<!doctype html><div id="root"></div>',
    );
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('spa');");

    const app = await createApp(
      readConfig({
        DATA_DIR: dataDir,
        ALLOWED_ORIGIN: ORIGIN,
        NODE_ENV: "test",
        STATIC_DIR: webDir,
      }),
    );
    openApps.push(app);

    const deep = await app.inject({ method: "GET", url: "/review" });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers["content-type"]).toContain("text/html");

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("javascript");

    const unknown = await app.inject({
      method: "GET",
      url: "/api/does-not-exist",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers["content-type"]).toContain("application/json");
    expect(unknown.json()).toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed when the persisted schema is newer than the application", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-accept-migration-"));
    tempRoots.push(dataDir);
    const seed = openStore(dataDir);
    seed.db
      .prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      )
      .run(9999, new Date().toISOString());
    await closeStore(seed);

    // The store refuses to open, so readiness can never report ready.
    expect(() => openStore(dataDir)).toThrow(/newer than this application/);
    await expect(
      createApp(
        readConfig({
          DATA_DIR: dataDir,
          ALLOWED_ORIGIN: ORIGIN,
          NODE_ENV: "test",
        }),
      ),
    ).rejects.toThrow(/newer than this application/);
    // A failed startup releases the data-dir lock and keeps failing closed.
    await expect(
      createApp(
        readConfig({
          DATA_DIR: dataDir,
          ALLOWED_ORIGIN: ORIGIN,
          NODE_ENV: "test",
        }),
      ),
    ).rejects.toThrow(/newer than this application/);
  });

  // A container always runs the app as pid 1, so a lock left by an uncleanly
  // killed process must not look alive after the pid is reused on restart.
  it.runIf(existsSync("/proc/self/stat"))(
    "recovers a data-dir lock whose pid was reused across a restart",
    () => {
      const dir = trackTemp("ibkr-accept-pid-reuse-");
      writeFileSync(
        join(dir, "journal.lock"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date(0).toISOString(),
          pidStart: "definitely-not-this-process",
        }),
      );
      expect(isDataDirLocked(dir)).toBe(false);
      const lock = acquireDataDirLock(dir);
      try {
        expect(isDataDirLocked(dir)).toBe(true);
      } finally {
        lock.release();
      }
      expect(isDataDirLocked(dir)).toBe(false);
    },
  );

  it("SIGTERM leaves the active build pointer intact and never activates a partial build", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-accept-shutdown-"));
    tempRoots.push(dataDir);
    let enterGate!: () => void;
    const entered = new Promise<void>((resolve) => {
      enterGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const app = await createApp(
      readConfig({
        DATA_DIR: dataDir,
        ALLOWED_ORIGIN: ORIGIN,
        NODE_ENV: "test",
      }),
      {
        buildOptions: {
          faults: {
            afterCompute: () => {
              enterGate();
              return gate;
            },
          },
        },
        onReady: (context) => {
          capturedStore = context.store;
        },
      },
    );
    openApps.push(app);

    const buildResponse = await app.inject({
      method: "POST",
      url: "/api/builds",
      headers: { origin: ORIGIN },
      payload: { mode: "full" },
    });
    expect(buildResponse.statusCode).toBe(202);
    const { jobId } = buildResponse.json() as { jobId: string };

    await entered;
    const controller = new AbortController();
    const closing = shutdown(capturedStore as Store, controller.signal);
    releaseGate();
    await closing;

    const journal = await app.inject("/api/journal?pageSize=1");
    expect(journal.statusCode).toBe(200);
    expect((journal.json() as { buildId: string | null }).buildId).toBeNull();

    const jobResponse = await app.inject(`/api/jobs/${jobId}`);
    expect(jobResponse.json()).toMatchObject({
      job: { status: expect.not.stringMatching("complete") },
    });
  });
});

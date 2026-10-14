import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import {
  ALGORITHM_VERSION,
  type BuildServiceOptions,
  rebuild,
} from "../../src/server/builds/service.js";
import { readConfig } from "../../src/server/config.js";
import { stageOriginalBytes } from "../../src/server/imports/files.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { LEDGER_PARSER_VERSION } from "../../src/server/ledger/normalize.js";
import { closeStore, openStore } from "../../src/server/storage/database.js";
import { fixtures } from "../fixtures/scenarios.js";

const ORIGIN = "http://localhost:3000";
const encoder = new TextEncoder();

const quarantineCsv = encoder.encode(
  [
    "ClientAccountID,AssetClass,Symbol,CurrencyPrimary,DateTime,Quantity,NetCash,Notes/Codes,TradeID,LevelOfDetail",
    "SIM-A,OPT,AXON,USD,2026-09-03 10:00:00,+1,-100,O,TRADE-Q-1,EXECUTION",
    "SIM-A,OPT,AXON,USD,2026-09-03 10:00:00,+1,-100,O,TRADE-Q-2,MYSTERY",
    "SIM-A,OPT,AXON,USD,2026-09-03 10:00:00,+1,-100,,",
  ].join("\n"),
);

const openApps: FastifyInstance[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    dataDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTestApp(
  overrides: {
    uploadLimitBytes?: number;
    buildOptions?: BuildServiceOptions;
  } = {},
): Promise<FastifyInstance> {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-http-"));
  dataDirs.push(dataDir);
  const env: Record<string, string> = {
    DATA_DIR: dataDir,
    ALLOWED_ORIGIN: ORIGIN,
  };
  if (overrides.uploadLimitBytes !== undefined) {
    env.UPLOAD_LIMIT_BYTES = String(overrides.uploadLimitBytes);
  }
  const app = await createApp(readConfig(env), {
    ...(overrides.buildOptions === undefined
      ? {}
      : { buildOptions: overrides.buildOptions }),
  });
  openApps.push(app);
  return app;
}

interface MultipartFile {
  filename: string;
  content: Uint8Array;
}

function multipartPayload(files: MultipartFile[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = "----ibkr-test-boundary-7f3a";
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          "Content-Type: text/csv\r\n\r\n",
      ),
    );
    chunks.push(Buffer.from(file.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function previewFile(
  app: FastifyInstance,
  filename: string,
  bytes: Uint8Array,
): Promise<{ id: string; hash: string }> {
  const { payload, headers } = multipartPayload([{ filename, content: bytes }]);
  const response = await app.inject({
    method: "POST",
    url: "/api/imports/preview?timezone=UTC",
    headers: { ...headers, origin: ORIGIN },
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json() as {
    previews: Array<{ id: string; hash: string }>;
  };
  const preview = body.previews[0];
  if (preview === undefined) throw new Error("missing preview");
  return preview;
}

async function commitPreview(
  app: FastifyInstance,
  previewId: string,
): Promise<{ importId: string; duplicate: boolean }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/imports/${previewId}/commit`,
    headers: { origin: ORIGIN },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { importId: string; duplicate: boolean };
}

async function uploadAndCommit(
  app: FastifyInstance,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const preview = await previewFile(app, filename, bytes);
  const committed = await commitPreview(app, preview.id);
  return committed.importId;
}

async function waitForTerminalJob(
  app: FastifyInstance,
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
    });
    expect(response.statusCode).toBe(200);
    const job = (response.json() as { job: Record<string, unknown> }).job;
    if (
      ["complete", "failed", "cancelled", "interrupted"].includes(
        String(job.status),
      )
    ) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}

async function startBuild(
  app: FastifyInstance,
  mode: "full" | "projection" = "full",
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/builds",
    headers: { origin: ORIGIN },
    payload: { mode },
  });
  expect(response.statusCode, response.body).toBe(202);
  return (response.json() as { jobId: string }).jobId;
}

/**
 * Seeds a store that looks like a process died mid-build: a valid active
 * generation plus a non-terminal candidate row, and an orphan staging file no
 * preview references.
 */
async function seedInterruptedStartup(dataDir: string): Promise<{
  interruptedId: string;
  activeId: string;
}> {
  const store = openStore(dataDir);
  try {
    const preview = await previewImport(store, {
      filename: "spread.csv",
      bytes: fixtures.spread,
      timezone: "UTC",
    });
    await commitImport(store, preview.id);
    const result = await rebuild(store, {
      mode: "full",
      parserVersion: LEDGER_PARSER_VERSION,
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("active");
    const activeId = (
      store.db
        .prepare(
          "SELECT active_build_id AS id FROM app_state WHERE singleton = 1",
        )
        .get() as { id: string }
    ).id;
    const ledgerId = (
      store.db
        .prepare("SELECT ledger_build_id AS id FROM builds WHERE id = ?")
        .get(activeId) as { id: string }
    ).id;
    const interruptedId = "interrupted-build";
    store.db
      .prepare(
        `INSERT INTO builds (
           id, ledger_build_id, decision_watermark, algorithm_version,
           input_hash, status, validation_json
         ) VALUES (?, ?, 0, ?, 'interrupted-hash', 'running', '[]')`,
      )
      .run(interruptedId, ledgerId, ALGORITHM_VERSION);
    stageOriginalBytes(store.sourceRoot, "orphan-preview", fixtures.roll);
    return { interruptedId, activeId };
  } finally {
    await closeStore(store);
  }
}

function collectSecretKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectSecretKeys(entry, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[_-]/g, "");
      if (
        [
          "secret",
          "apikey",
          "authorization",
          "password",
          "credential",
          "token",
        ].includes(normalized)
      ) {
        found.push(key);
      }
      collectSecretKeys(entry, found);
    }
  }
  return found;
}

describe("validated HTTP API", () => {
  it("rejects an out-of-range page size with a uniform 400 error", async () => {
    const app = await createTestApp();
    const response = await app.inject("/api/journal?pageSize=101");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect((await app.inject("/api/journal?page=0")).statusCode).toBe(400);
  });

  it("rejects cross-origin mutations before body validation", async () => {
    const app = await createTestApp();
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/builds",
      headers: { origin: "https://other.example" },
      payload: { mode: "full" },
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ code: "CROSS_ORIGIN_REJECTED" });

    const missing = await app.inject({
      method: "POST",
      url: "/api/builds",
      payload: { mode: "full" },
    });
    expect(missing.statusCode).toBe(403);
  });

  it("reports a null build id before any build exists", async () => {
    const app = await createTestApp();
    const journal = await app.inject("/api/journal");
    expect(journal.statusCode).toBe(200);
    const body = journal.json() as Record<string, unknown>;
    expect(body.buildId).toBeNull();
    expect(body.items).toEqual([]);
    expect(body.pageSize).toBe(25);

    const review = await app.inject("/api/review");
    expect(review.json()).toMatchObject({ buildId: null, items: [] });
  });

  it("answers liveness and readiness without a running model", async () => {
    const app = await createTestApp();
    expect((await app.inject("/health/live")).statusCode).toBe(200);
    const ready = await app.inject("/health/ready");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ok" });
  });

  it("enforces the multipart size bound before buffering the whole file", async () => {
    const app = await createTestApp({ uploadLimitBytes: 16 });
    const { payload, headers } = multipartPayload([
      { filename: "large.csv", content: new Uint8Array(4096).fill(65) },
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/api/imports/preview",
      headers: { ...headers, origin: ORIGIN },
      payload,
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "IMPORT_TOO_LARGE" });
  });

  it("treats malicious filenames as inert data and content-addresses originals", async () => {
    const app = await createTestApp();
    const preview = await previewFile(app, "../../escape.csv", fixtures.spread);
    const committed = await commitPreview(app, preview.id);
    expect(committed.duplicate).toBe(false);

    const list = await app.inject("/api/imports");
    const items = (list.json() as { items: Array<Record<string, string>> })
      .items;
    const imported = items.find((entry) => entry.id === committed.importId);
    // The multipart parser reduces the name to its basename; either way the
    // filename is inert and the stored path is derived only from content hash.
    expect(imported?.filename).toBe("escape.csv");
    expect(imported?.sha256).toBe(preview.hash);
    expect(imported?.originalFilePath).toBe(
      `originals/${preview.hash.slice(0, 2)}/${preview.hash}`,
    );
  });

  it("keeps raw preview and commit provenance, including quarantines with no active ledger", async () => {
    const app = await createTestApp();
    const preview = await previewFile(app, "quarantine.csv", quarantineCsv);
    const committed = await commitPreview(app, preview.id);

    const rows = await app.inject(`/api/imports/${committed.importId}/rows`);
    expect(rows.statusCode).toBe(200);
    const body = rows.json() as {
      items: Array<{
        rowNumber: number;
        kind: string;
        fields: Record<string, string>;
      }>;
      total: number;
      buildId: string | null;
    };
    expect(body.total).toBe(3);
    expect(body.items.map((row) => row.kind)).toEqual([
      "execution",
      "quarantine",
      "quarantine",
    ]);
    expect(body.items[1]?.fields.TradeID).toBe("TRADE-Q-2");
    expect(body.buildId).toBeNull();
  });

  it("rejects unsupported JSON content types with 415", async () => {
    const app = await createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/decisions",
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      payload: '{"kind":"notes"}',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("rejects stale decisions with 409 and is idempotent by client request id", async () => {
    const app = await createTestApp();
    const decision = {
      kind: "notes",
      clientRequestId: "req-1",
      sources: [],
      strategyIds: ["strategy-a"],
      supersedesId: null,
      author: "user",
      payload: { strategyId: "strategy-a", text: "first" },
    };

    const first = await app.inject({
      method: "POST",
      url: "/api/decisions",
      headers: { origin: ORIGIN },
      payload: decision,
    });
    expect(first.statusCode, first.body).toBe(201);
    const firstId = (first.json() as { decision: { id: string } }).decision.id;

    const repeat = await app.inject({
      method: "POST",
      url: "/api/decisions",
      headers: { origin: ORIGIN },
      payload: decision,
    });
    expect(repeat.statusCode).toBe(201);
    expect((repeat.json() as { decision: { id: string } }).decision.id).toBe(
      firstId,
    );

    const stale = await app.inject({
      method: "POST",
      url: "/api/decisions",
      headers: { origin: ORIGIN },
      payload: { ...decision, clientRequestId: "req-2", expectedWatermark: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "STALE_INPUT" });
  });

  it("returns build-consistent paginated projections after a rebuild", async () => {
    const app = await createTestApp();
    await uploadAndCommit(app, "spread.csv", fixtures.spread);
    const jobId = await startBuild(app, "full");
    const job = await waitForTerminalJob(app, jobId);
    expect(job.status).toBe("complete");

    const full = await app.inject("/api/journal?pageSize=100");
    const fullBody = full.json() as {
      items: Array<{ id: string }>;
      buildId: string;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(fullBody.buildId).not.toBeNull();
    expect(fullBody.total).toBeGreaterThan(0);

    const page = await app.inject("/api/journal?page=1&pageSize=1");
    const pageBody = page.json() as {
      items: Array<{ id: string }>;
      buildId: string;
      total: number;
      pageSize: number;
    };
    expect(pageBody.pageSize).toBe(1);
    expect(pageBody.items).toHaveLength(1);
    expect(pageBody.total).toBe(fullBody.total);
    expect(pageBody.buildId).toBe(fullBody.buildId);
    expect(fullBody.items.map((entry) => entry.id)).toContain(
      pageBody.items[0]?.id,
    );

    const strategyId = fullBody.items[0]?.id;
    const strategy = await app.inject(`/api/strategies/${strategyId}`);
    expect(strategy.statusCode).toBe(200);
    expect((strategy.json() as { strategy: { id: string } }).strategy.id).toBe(
      strategyId,
    );
    expect((await app.inject("/api/strategies/missing")).statusCode).toBe(404);

    expect((await app.inject("/api/transactions")).statusCode).toBe(200);
    expect((await app.inject("/api/lots")).statusCode).toBe(200);
    expect((await app.inject("/api/review")).json()).toMatchObject({
      buildId: fullBody.buildId,
    });
  });

  it("streams terminal job status over SSE and persists progress on reconnect", async () => {
    const app = await createTestApp();
    await uploadAndCommit(app, "spread.csv", fixtures.spread);
    const jobId = await startBuild(app, "full");
    const job = await waitForTerminalJob(app, jobId);
    expect(job.progress).not.toBeNull();

    const events = await app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events`,
    });
    expect(events.statusCode).toBe(200);
    expect(events.headers["content-type"]).toContain("text/event-stream");
    expect(events.body).toContain("event: status");
    expect(events.body).toContain("event: terminal");
    expect(events.body).toContain('"status":"complete"');

    const reconnect = await app.inject(`/api/jobs/${jobId}`);
    expect((reconnect.json() as { job: { status: string } }).job.status).toBe(
      "complete",
    );
  });

  it("cancels an in-flight build without activating it", async () => {
    let gate: (() => Promise<void>) | null = null;
    let release: (() => void) | null = null;

    const app = await createTestApp({
      buildOptions: {
        faults: {
          afterCompute: async () => {
            if (gate !== null) await gate();
          },
        },
      },
    });
    await uploadAndCommit(app, "spread.csv", fixtures.spread);

    const firstJob = await startBuild(app, "full");
    expect((await waitForTerminalJob(app, firstJob)).status).toBe("complete");
    const activeBefore = (
      (await app.inject("/api/journal")).json() as { buildId: string }
    ).buildId;
    expect(activeBefore).not.toBeNull();

    gate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const secondJob = await startBuild(app, "full");

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/jobs/${secondJob}/cancel`,
      headers: { origin: ORIGIN },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { job: { status: string } }).job.status).toBe(
      "cancelled",
    );

    if (release !== null) (release as () => void)();
    gate = null;
    const settled = await waitForTerminalJob(app, secondJob);
    expect(settled.status).toBe("cancelled");

    const activeAfter = (
      (await app.inject("/api/journal")).json() as { buildId: string }
    ).buildId;
    expect(activeAfter).toBe(activeBefore);
  });

  it("never returns provider credentials or secret values", async () => {
    const app = await createTestApp();
    await uploadAndCommit(app, "spread.csv", fixtures.spread);
    const jobId = await startBuild(app, "full");
    await waitForTerminalJob(app, jobId);

    for (const url of [
      "/health/ready",
      "/api/journal",
      "/api/imports",
      "/api/transactions",
      `/api/jobs/${jobId}`,
    ]) {
      const response = await app.inject(url);
      expect(collectSecretKeys(response.json()), url).toEqual([]);
    }
  });

  it("runs startup recovery when composing the app", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "ibkr-http-recovery-"));
    dataDirs.push(dataDir);
    const { interruptedId, activeId } = await seedInterruptedStartup(dataDir);
    const orphanStaging = join(
      dataDir,
      "originals",
      ".staging",
      "orphan-preview.part",
    );
    expect(existsSync(orphanStaging)).toBe(true);

    const app = await createApp(
      readConfig({ DATA_DIR: dataDir, ALLOWED_ORIGIN: ORIGIN }),
    );
    openApps.push(app);

    expect(existsSync(orphanStaging)).toBe(false);

    const rollback = await app.inject({
      method: "POST",
      url: `/api/builds/${interruptedId}/rollback`,
      headers: { origin: ORIGIN },
    });
    expect(rollback.statusCode).toBe(409);
    expect(rollback.json()).toMatchObject({ code: "BUILD_NOT_ROLLBACKABLE" });

    const journal = await app.inject("/api/journal");
    expect((journal.json() as { buildId: string }).buildId).toBe(activeId);
  });
});

import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app.js";
import { readConfig } from "../../src/server/config.js";
import { commitImport } from "../../src/server/imports/service.js";
import type { Store } from "../../src/server/storage/database.js";
import { fixtures } from "../fixtures/scenarios.js";

const origin = "http://localhost:3000";

function multipart(files: Uint8Array[]) {
  const boundary = "import-limit-test-boundary";
  return {
    method: "POST" as const,
    url: "/api/imports/preview",
    headers: {
      origin,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      ...files.flatMap((bytes, index) => [
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${index}.csv"\r\nContent-Type: text/csv\r\n\r\n`,
        ),
        Buffer.from(bytes),
        Buffer.from("\r\n"),
      ]),
      Buffer.from(`--${boundary}--\r\n`),
    ]),
  };
}

async function withApp(
  limitBytes: number,
  run: (
    app: Awaited<ReturnType<typeof createApp>>,
    store: Store,
  ) => Promise<void>,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "ibkr-import-limit-"));
  let store: Store | undefined;
  const app = await createApp(
    readConfig({
      DATA_DIR: dataDir,
      ALLOWED_ORIGIN: origin,
      UPLOAD_LIMIT_BYTES: String(limitBytes),
    }),
    {
      onReady: (context) => {
        store = context.store;
      },
    },
  );
  try {
    if (store === undefined) throw new Error("App did not expose its store.");
    await run(app, store);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe("configured import limits and failed request cleanup", () => {
  // Real above-default bytes must be parsed twice (preview and commit). Allow
  // V8 instrumentation overhead; this checks configured limits, not throughput.
  it("previews and commits an accepted CSV above the default 20 MiB limit", async () => {
    const bytes = Buffer.from(
      "ClientAccountID,AssetClass,Symbol,CurrencyPrimary,DateTime,Quantity,NetCash,TradeID,Description\n" +
        "SIM-A,STK,AXON,USD,2026-09-03 10:00:00,1,-100,LARGE-1," +
        "x".repeat(20 * 1024 * 1024),
    );
    await withApp(bytes.length + 1, async (app, store) => {
      const response = await app.inject(multipart([bytes]));
      expect(response.statusCode, response.body).toBe(201);
      const preview = response.json().previews[0];
      expect(preview.counts.executions).toBe(1);
      expect(preview.committable).toBe(true);
      // Chat and HTTP commits must both retain the rows of an accepted preview.
      const committed = await commitImport(store, preview.id);
      expect(
        store.db
          .prepare("SELECT row_kind FROM import_rows WHERE import_id = ?")
          .all(committed.importId),
      ).toEqual([{ row_kind: "execution" }]);
    });
  }, 120_000);

  it.each(["oversize", "file-count"] as const)(
    "removes only this request's staged previews after a later %s failure",
    async (failure) => {
      const limit = fixtures.spread.length + 1;
      await withApp(limit, async (app, store) => {
        const kept = await app.inject(multipart([fixtures.spread]));
        expect(kept.statusCode).toBe(201);
        const keptId = kept.json().previews[0].id;
        const files =
          failure === "oversize"
            ? [fixtures.spread, new Uint8Array(limit + 1)]
            : Array.from({ length: 21 }, () => fixtures.spread);
        const failed = await app.inject(multipart(files));
        expect(failed.statusCode, failed.body).toBe(413);
        expect(
          store.db.prepare("SELECT id FROM import_previews").all(),
        ).toEqual([{ id: keptId }]);
        expect(readdirSync(join(store.sourceRoot, ".staging"))).toEqual([
          `${keptId}.part`,
        ]);
        await expect(commitImport(store, keptId)).resolves.toMatchObject({
          duplicate: false,
        });
      });
    },
  );
});

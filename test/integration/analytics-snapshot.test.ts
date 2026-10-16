import { describe, expect, it } from "vitest";
import { readAnalyticsSnapshot } from "../../src/server/analytics/snapshot.js";
import { ALGORITHM_VERSION, rebuild } from "../../src/server/builds/service.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import {
  LEDGER_PARSER_VERSION,
  normalizeLedger,
} from "../../src/server/ledger/normalize.js";
import { fixtures } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

describe("analytics snapshot", () => {
  it("returns empty provenance before first build", async () => {
    const { store, dispose } = await createTestStore();
    try {
      expect(
        readAnalyticsSnapshot(store, new Date("2026-10-16T00:00:00Z")),
      ).toMatchObject({
        buildId: null,
        ledgerId: null,
        projection: null,
        ledger: null,
        stale: false,
        generatedAt: "2026-10-16T00:00:00.000Z",
      });
    } finally {
      await dispose();
    }
  });
  it("follows the active build ledger and reports stale inputs without rebuilding", async () => {
    const { store, dispose } = await createTestStore();
    try {
      const preview = await previewImport(store, {
        filename: "spread.csv",
        bytes: fixtures.spread,
        timezone: "UTC",
      });
      await commitImport(store, preview.id);
      await rebuild(store, {
        mode: "full",
        parserVersion: LEDGER_PARSER_VERSION,
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      const first = readAnalyticsSnapshot(store);
      expect(first.ledgerId).toBe(first.projection?.ledgerId);
      expect(first.ledger?.executions.length).toBe(4);
      const next = await previewImport(store, {
        filename: "extra.csv",
        bytes: fixtures.assignment,
        timezone: "UTC",
      });
      await commitImport(store, next.id);
      await normalizeLedger(store, {
        parserVersion: LEDGER_PARSER_VERSION,
        decisionWatermark: 0,
      });
      const stale = readAnalyticsSnapshot(store);
      expect(stale.buildId).toBe(first.buildId);
      expect(stale.ledger?.id).toBe(first.ledgerId);
      expect(stale.stale).toBe(true);
      store.db.pragma("foreign_keys = OFF");
      store.db
        .prepare("UPDATE builds SET ledger_build_id = ? WHERE id = ?")
        .run("missing", first.buildId);
      expect(() => readAnalyticsSnapshot(store)).toThrowError(
        expect.objectContaining({ code: "ANALYTICS_SNAPSHOT_INVALID" }),
      );
    } finally {
      await dispose();
    }
  });
});

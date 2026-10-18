import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { selectAnalyticsDetails } from "../../src/server/analytics/details.js";
import { parseDetailQuery } from "../../src/server/analytics/query.js";
import { createApp } from "../../src/server/app.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { readConfig } from "../../src/server/config.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import { performanceFixture, strategy } from "../fixtures/analytics.js";
import { fixtures } from "../fixtures/scenarios.js";
import { analyticsApp } from "../helpers/analytics-app.js";
import { createTestStore } from "../helpers/store.js";

describe("analytics HTTP", () => {
  it("serves matching persisted lifecycle summaries, drills and exports and requires historical rebuilds", async () => {
    const t = await createTestStore();
    const app = await createApp(
      readConfig({
        DATA_DIR: t.dataDir,
        ALLOWED_ORIGIN: "http://localhost:3000",
      }),
    );
    try {
      const preview = await previewImport(t.store, {
        filename: "spread.csv",
        bytes: fixtures.spread,
        timezone: "UTC",
      });
      await commitImport(t.store, preview.id);
      await rebuild(t.store, {
        mode: "full",
        parserVersion: "flex-v1",
        algorithmVersion: ALGORITHM_VERSION,
        signal: new AbortController().signal,
      });
      const summary = await app.inject("/api/analytics?basis=reconstructed");
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toMatchObject({
        unit: "lifecycle",
        performance: { closed: 1, eligible: 1, pnl: "-451.6607454" },
      });
      const detail = await app.inject(
        "/api/analytics/details?kind=strategies&basis=reconstructed",
      );
      expect(detail.statusCode).toBe(200);
      expect(detail.json().total).toBe(summary.json().performance.closed);
      expect(detail.json().items[0].selectedPnl).toBe(
        summary.json().performance.pnl,
      );
      const exported = await app.inject(
        "/api/analytics/export?dataset=strategies&basis=reconstructed",
      );
      expect(exported.statusCode).toBe(200);
      expect(parse(exported.body, { columns: true })).toMatchObject([
        {
          id: detail.json().items[0].id,
          unit: "lifecycle",
          selectedPnl: "-451.6607454",
          stage: "closed",
        },
      ]);
      const buildId = activeProjection(t.store).buildId;
      t.store.db
        .prepare("DELETE FROM lifecycle_projection_views WHERE build_id=?")
        .run(buildId);
      const historical = await app.inject("/api/analytics");
      expect(historical.statusCode).toBe(409);
      expect(historical.json().code).toBe("LIFECYCLE_REBUILD_REQUIRED");
      expect(
        (await app.inject("/api/analytics?unit=strategy")).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
      await t.dispose();
    }
  });
  it("registers the API on the real application and returns no-build state", async () => {
    const t = await createTestStore();
    const app = await createApp(
      readConfig({
        DATA_DIR: t.dataDir,
        ALLOWED_ORIGIN: "http://localhost:3000",
      }),
    );
    try {
      const r = await app.inject("/api/analytics");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        buildId: null,
        performance: { pnl: null, closed: 0 },
      });
    } finally {
      await app.close();
      await t.dispose();
    }
  });
  it("serves full totals, scoped pages, and structured validation/build errors", async () => {
    const t = await analyticsApp();
    try {
      const r = await t.app.inject("/api/analytics?unit=strategy&currency=USD");
      expect(r.statusCode).toBe(200);
      expect(r.json().performance).toMatchObject({
        closed: 679,
        pnl: "10456.24",
      });
      const d = await t.app.inject(
        "/api/analytics/details?unit=strategy&kind=strategies&currency=USD&pageSize=25",
      );
      expect(d.json()).toMatchObject({ total: 679, pageSize: 25 });
      expect(d.json().items).toHaveLength(25);
      const w = await t.app.inject(
        "/api/analytics/details?unit=strategy&kind=strategies&currency=USD&outcome=win",
      );
      expect(w.json().total).toBe(481);
      const open = await t.app.inject(
        "/api/analytics/details?unit=strategy&kind=strategies&currency=USD&scope=current-open&to=2000-01-01",
      );
      expect(open.json().total).toBe(19);
      for (const q of ["from=2026-02-30", "currency=EUR", "unknown=1"]) {
        expect(
          (await t.app.inject(`/api/analytics?unit=strategy&${q}`)).statusCode,
        ).toBe(400);
      }
      expect(
        (
          await t.app.inject(
            "/api/analytics/details?unit=strategy&kind=strategies&expectedBuildId=old",
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await t.app.inject(
            "/api/analytics/details?unit=strategy&kind=strategies&sort=bad",
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await t.app.inject(
            "/api/analytics/details?unit=strategy&kind=strategies&groupBy=underlying&group=bogus",
          )
        ).statusCode,
      ).toBe(400);
    } finally {
      await t.close();
    }
  });
  it("sorts exact money null-last and exposes undated/unresolved scopes", () => {
    const s = performanceFixture();
    s.projection.strategies = [
      strategy({ id: "a", brokerPnl: "100" }),
      strategy({ id: "b", brokerPnl: "9" }),
      strategy({ id: "c", brokerPnl: null }),
      strategy({ id: "u", closeDate: null }),
      strategy({ id: "x", status: "unresolved" }),
    ];
    const run = (raw: Record<string, string>) =>
      selectAnalyticsDetails(
        s,
        parseDetailQuery({
          unit: "strategy",
          kind: "strategies",
          currency: "USD",
          ...raw,
        }),
      );
    expect(
      run({ sort: "pnl", direction: "asc" }).items.map((x) =>
        "id" in x ? x.id : "",
      ),
    ).toEqual(["b", "a", "c"]);
    expect(run({ scope: "undated-closed" }).total).toBe(1);
    expect(run({ scope: "unresolved" }).total).toBe(1);
  });
});

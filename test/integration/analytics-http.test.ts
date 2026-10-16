import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { selectAnalyticsDetails } from "../../src/server/analytics/details.js";
import { parseDetailQuery } from "../../src/server/analytics/query.js";
import { createApp } from "../../src/server/app.js";
import { persistProjection } from "../../src/server/builds/repository.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { readConfig } from "../../src/server/config.js";
import { registerAnalyticsRoutes } from "../../src/server/http/routes-analytics.js";
import type { AppError } from "../../src/shared/errors.js";
import { performanceFixture, strategy } from "../fixtures/analytics.js";
import { createTestStore } from "../helpers/store.js";
export async function analyticsApp() {
  const t = await createTestStore();
  await rebuild(t.store, {
    mode: "full",
    parserVersion: "flex-v1",
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
  const active = activeProjection(t.store);
  await persistProjection(
    t.store,
    active.buildId!,
    active.projection!.ledgerId,
    {
      ...performanceFixture().projection!,
      ledgerId: active.projection!.ledgerId,
    },
    new Date().toISOString(),
  );
  const app = Fastify();
  app.setErrorHandler((e, _req, reply) => {
    const error = e as AppError;
    reply
      .code(error.statusCode ?? 500)
      .send({ code: error.code, message: error.message });
  });
  await registerAnalyticsRoutes(app, t.store);
  return {
    ...t,
    app,
    close: async () => {
      await app.close();
      await t.dispose();
    },
  };
}
describe("analytics HTTP", () => {
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
      const r = await t.app.inject("/api/analytics?currency=USD");
      expect(r.statusCode).toBe(200);
      expect(r.json().performance).toMatchObject({
        closed: 679,
        pnl: "10456.24",
      });
      const d = await t.app.inject(
        "/api/analytics/details?kind=strategies&currency=USD&pageSize=25",
      );
      expect(d.json()).toMatchObject({ total: 679, pageSize: 25 });
      expect(d.json().items).toHaveLength(25);
      const w = await t.app.inject(
        "/api/analytics/details?kind=strategies&currency=USD&outcome=win",
      );
      expect(w.json().total).toBe(481);
      const open = await t.app.inject(
        "/api/analytics/details?kind=strategies&currency=USD&scope=current-open&to=2000-01-01",
      );
      expect(open.json().total).toBe(19);
      for (const q of ["from=2026-02-30", "currency=EUR", "unknown=1"]) {
        expect((await t.app.inject(`/api/analytics?${q}`)).statusCode).toBe(
          400,
        );
      }
      expect(
        (
          await t.app.inject(
            "/api/analytics/details?kind=strategies&expectedBuildId=old",
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (await t.app.inject("/api/analytics/details?kind=strategies&sort=bad"))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await t.app.inject(
            "/api/analytics/details?kind=strategies&groupBy=underlying&group=bogus",
          )
        ).statusCode,
      ).toBe(400);
    } finally {
      await t.close();
    }
  });
  it("sorts exact money null-last and exposes undated/unresolved scopes", () => {
    const s = performanceFixture();
    s.projection!.strategies = [
      strategy({ id: "a", brokerPnl: "100" }),
      strategy({ id: "b", brokerPnl: "9" }),
      strategy({ id: "c", brokerPnl: null }),
      strategy({ id: "u", closeDate: null }),
      strategy({ id: "x", status: "unresolved" }),
    ];
    const run = (raw: Record<string, string>) =>
      selectAnalyticsDetails(
        s,
        parseDetailQuery({ kind: "strategies", currency: "USD", ...raw }),
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

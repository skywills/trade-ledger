import Fastify from "fastify";
import { expect, it } from "vitest";
import { ALGORITHM_VERSION, rebuild } from "../../src/server/builds/service.js";
import { registerLifecycleRoutes } from "../../src/server/http/routes-lifecycles.js";
import { registerReviewRoutes } from "../../src/server/http/routes-review.js";
import {
  commitImport,
  previewImport,
} from "../../src/server/imports/service.js";
import type { AppError } from "../../src/shared/errors.js";
import { fixtures } from "../fixtures/scenarios.js";
import { createTestStore } from "../helpers/store.js";

it("exposes consistent lifecycle provenance and refuses stale build drilldowns", async () => {
  const t = await createTestStore();
  const app = Fastify();
  app.setErrorHandler((e, _r, reply) => {
    const error = e as AppError;
    reply
      .code(error.statusCode ?? 500)
      .send({ code: error.code, message: error.message });
  });
  try {
    await registerLifecycleRoutes(app, t.store);
    await registerReviewRoutes(app, t.store);
    const preview = await previewImport(t.store, {
      filename: "assignment.csv",
      bytes: fixtures.assignment,
      timezone: "UTC",
    });
    await commitImport(t.store, preview.id);
    await rebuild(t.store, {
      mode: "full",
      parserVersion: "flex-v1",
      algorithmVersion: ALGORITHM_VERSION,
      signal: new AbortController().signal,
    });
    const list = await app.inject("/api/lifecycles");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.rebuildRequired).toBe(false);
    expect(body.lifecycles.lifecycles.length).toBeGreaterThan(0);
    const id = body.lifecycles.lifecycles[0].id;
    const detail = await app.inject(
      `/api/lifecycles/${id}?expectedBuildId=${body.buildId}`,
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.json().members.length).toBeGreaterThan(0);
    expect(detail.json().executions.length).toBeGreaterThan(0);
    expect(
      (await app.inject(`/api/lifecycles/${id}?expectedBuildId=old`))
        .statusCode,
    ).toBe(409);
    expect((await app.inject("/api/lifecycles/missing")).statusCode).toBe(404);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/decisions",
      payload: {
        kind: "wheel_campaign_membership",
        clientRequestId: "bad",
        author: "user",
        expectedWatermark: body.watermark,
        payload: { lifecycleId: id, campaignId: "missing" },
      },
    });
    expect(invalid.statusCode).toBe(409);
  } finally {
    await app.close();
    await t.dispose();
  }
});

import Fastify from "fastify";
import { persistProjection } from "../../src/server/builds/repository.js";
import {
  ALGORITHM_VERSION,
  activeProjection,
  rebuild,
} from "../../src/server/builds/service.js";
import { registerAnalyticsRoutes } from "../../src/server/http/routes-analytics.js";
import type { AppError } from "../../src/shared/errors.js";
import { performanceFixture } from "../fixtures/analytics.js";
import { createTestStore } from "./store.js";
export async function analyticsApp() {
  const t = await createTestStore();
  await rebuild(t.store, {
    mode: "full",
    parserVersion: "flex-v1",
    algorithmVersion: ALGORITHM_VERSION,
    signal: new AbortController().signal,
  });
  const active = activeProjection(t.store);
  if (!active.buildId || !active.projection)
    throw new Error("Synthetic build failed");
  await persistProjection(
    t.store,
    active.buildId,
    active.projection.ledgerId,
    {
      ...performanceFixture().projection,
      ledgerId: active.projection.ledgerId,
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

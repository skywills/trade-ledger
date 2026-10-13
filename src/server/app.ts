import Fastify, { type FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";

export async function createApp(_config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/health/live", async () => ({ status: "ok" }));

  return app;
}

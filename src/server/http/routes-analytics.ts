import type { FastifyInstance } from "fastify";
import { aggregateAnalytics } from "../analytics/aggregate.js";
import { serializeAnalyticsCsv } from "../analytics/csv.js";
import { selectAnalyticsDetails } from "../analytics/details.js";
import {
  parseAnalyticsQuery,
  parseDetailQuery,
  parseExportQuery,
} from "../analytics/query.js";
import { readAnalyticsSnapshot } from "../analytics/snapshot.js";
import type { Store } from "../storage/database.js";
export async function registerAnalyticsRoutes(
  app: FastifyInstance,
  store: Store,
): Promise<void> {
  app.get("/api/analytics", (request) => {
    const q = parseAnalyticsQuery(request.query);
    return aggregateAnalytics(readAnalyticsSnapshot(store), q);
  });
  app.get("/api/analytics/details", (request) => {
    const q = parseDetailQuery(request.query);
    return selectAnalyticsDetails(readAnalyticsSnapshot(store), q);
  });
  app.get("/api/analytics/export", (request, reply) => {
    const q = parseExportQuery(request.query);
    const result = serializeAnalyticsCsv(readAnalyticsSnapshot(store), q);
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="${result.filename}"`,
      )
      .send(result.csv);
  });
}

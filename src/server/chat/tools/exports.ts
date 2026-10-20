import { z } from "zod";
import {
  AnalyticsQuerySchema,
  ExportQuerySchema,
} from "../../../shared/analytics.js";
import { serializeAnalyticsCsv } from "../../analytics/csv.js";
import { parseExportQuery } from "../../analytics/query.js";
import { resolveScope } from "../../analytics/scope.js";
import {
  type ChatTool,
  type ChatToolContext,
  defineReadTool,
  jsonResult,
} from "./shared.js";
import { readToolSnapshot, snapshotMeta } from "./snapshot.js";

const Query = ExportQuerySchema.safeExtend({
  expectedBuildId: z.string().min(1),
});
export function exportTools(ctx: ChatToolContext): ChatTool[] {
  return [
    defineReadTool(
      "export_analytics",
      "Validate a full-scope analytics CSV download for the current build. Returns filename and a relative downloadUrl, never CSV data or a filesystem artifact. Render [Download CSV](<downloadUrl>) using the exact returned URL. The user downloads on click; regenerate after a rebuild. Defaults match dashboard lifecycle/broker analytics.",
      Query,
      (raw) => {
        const query = parseExportQuery(raw);
        const snapshot = readToolSnapshot(ctx, raw.expectedBuildId);
        const base = AnalyticsQuerySchema.parse(
          Object.fromEntries(
            Object.entries(query).filter(
              ([key]) => key in AnalyticsQuerySchema.shape,
            ),
          ),
        );
        const resolved = resolveScope(snapshot, base).query;
        const pinned = parseExportQuery({
          ...query,
          ...resolved,
          expectedBuildId: snapshot.buildId,
        });
        const { filename } = serializeAnalyticsCsv(snapshot, pinned);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(pinned))
          if (value !== undefined) params.set(key, value);
        const { dataset, expectedBuildId: _expected, ...filters } = pinned;
        return jsonResult({
          ...snapshotMeta(snapshot),
          filters,
          dataset,
          filename,
          downloadUrl: `/api/analytics/export?${params.toString()}`,
        });
      },
    ),
  ];
}

import type { z } from "zod";
import {
  type AnalyticsQuery,
  AnalyticsQuerySchema,
  type DetailQuery,
  DetailQuerySchema,
  type ExportQuery,
  ExportQuerySchema,
} from "../../shared/analytics.js";
import { AppError } from "../../shared/errors.js";
export function invalid(message: string): never {
  throw new AppError("INVALID_ANALYTICS_QUERY", message, 400);
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) invalid(r.error.issues.map((x) => x.message).join(" "));
  return r.data;
}
export function parseAnalyticsQuery(raw: unknown): AnalyticsQuery {
  return parse(AnalyticsQuerySchema, raw);
}
function validateDrill(
  q: {
    scope: string;
    outcome?: string | undefined;
    group?: string | undefined;
    groupBy?: string | undefined;
  },
  kind: string,
) {
  if (
    kind === "transactions" &&
    (q.scope !== "closed" || q.outcome || q.groupBy === "strategyType")
  )
    invalid("Invalid transaction drill-down.");
  if (kind === "strategies" && q.groupBy === "event")
    invalid("Event grouping requires transactions.");
  if (q.outcome && q.scope !== "closed")
    invalid("Outcome requires closed trades.");
  if (Boolean(q.group) !== Boolean(q.groupBy))
    invalid("Supply both groupBy and group.");
}
export function parseDetailQuery(raw: unknown): DetailQuery {
  const q = parse(DetailQuerySchema, raw);
  validateDrill(q, q.kind);
  const keys =
    q.kind === "strategies"
      ? ["closeDate", "id", "pnl"]
      : ["date", "symbol", "quantity", "netCash"];
  if (q.sort && !keys.includes(q.sort)) invalid("Unsupported sort field.");
  return q;
}
export function parseExportQuery(raw: unknown): ExportQuery {
  const q = parse(ExportQuerySchema, raw);
  if (
    q.dataset === "summary" &&
    (q.scope !== "closed" || q.outcome || q.groupBy || q.date)
  )
    invalid("Summary export does not accept detail scope.");
  validateDrill(q, q.dataset);
  return q;
}

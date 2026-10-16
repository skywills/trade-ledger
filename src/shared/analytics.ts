import { z } from "zod";
export function validDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
const Day = z.string().refine(validDay, "Use a valid YYYY-MM-DD date.");
const Fields = {
  from: Day.optional(),
  to: Day.optional(),
  currency: z.string().min(1).optional(),
  basis: z.enum(["broker", "reconstructed"]).default("broker"),
  symbol: z.string().min(1).optional(),
  underlying: z.string().min(1).optional(),
  strategyType: z.string().min(1).optional(),
  assetClass: z.string().min(1).optional(),
};
const Drill = {
  scope: z
    .enum(["closed", "current-open", "unresolved", "undated-closed"])
    .default("closed"),
  outcome: z.enum(["win", "loss", "breakeven", "unavailable"]).optional(),
  groupBy: z
    .enum(["strategyType", "underlying", "assetClass", "event"])
    .optional(),
  group: z.string().min(1).optional(),
  date: Day.optional(),
  expectedBuildId: z.string().min(1).optional(),
};
function dateOrder(q: { from?: string; to?: string }) {
  return !q.from || !q.to || q.from <= q.to;
}
export const AnalyticsQuerySchema = z
  .object(Fields)
  .strict()
  .refine(dateOrder, "Start date must be on or before end date.");
export const DetailQuerySchema = z
  .object({
    ...Fields,
    ...Drill,
    kind: z.enum(["strategies", "transactions"]),
    sort: z.string().optional(),
    direction: z.enum(["asc", "desc"]).default("desc"),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine(dateOrder, "Invalid date range.");
export const ExportQuerySchema = z
  .object({
    ...Fields,
    ...Drill,
    dataset: z.enum(["summary", "strategies", "transactions"]),
  })
  .strict()
  .refine(dateOrder, "Invalid date range.");
export type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;
export type DetailQuery = z.infer<typeof DetailQuerySchema>;
export type ExportQuery = z.infer<typeof ExportQuerySchema>;

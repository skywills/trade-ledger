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
function dateOrder(q: { from?: string | undefined; to?: string | undefined }) {
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

const Amount = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .nullable();
const Count = z.number().int().nonnegative();
export const PerformanceSummarySchema = z.object({
  closed: Count,
  eligible: Count,
  missing: Count,
  wins: Count,
  losses: Count,
  breakeven: Count,
  open: Count,
  partiallyClosed: Count,
  pnl: Amount,
  winRatePct: Amount,
  averageWin: Amount,
  averageLoss: Amount,
  averagePnl: Amount,
  grossProfit: Amount,
  grossLoss: Amount,
  maxDrawdown: Amount,
  profitFactor: z.object({
    state: z.enum(["finite", "no-losses", "unavailable"]),
    value: Amount,
  }),
});
export type PerformanceSummary = z.infer<typeof PerformanceSummarySchema>;
const CoveredAmount = z.object({ value: Amount, known: Count, total: Count });
const CountGroup = z.object({
  key: z.string(),
  label: z.string(),
  count: Count,
});
export const TransactionSummarySchema = z.object({
  executions: Count,
  tradedSymbols: Count,
  netCash: Amount,
  commissions: CoveredAmount,
  taxes: CoveredAmount,
  byAssetClass: z.array(CountGroup),
  byEvent: z.array(CountGroup),
});
export type TransactionSummary = z.infer<typeof TransactionSummarySchema>;
export const GroupRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  closed: Count,
  eligible: Count,
  missing: Count,
  wins: Count,
  losses: Count,
  breakeven: Count,
  pnl: Amount,
  winRatePct: Amount,
});
export type GroupRow = z.infer<typeof GroupRowSchema>;
export const DailyPointSchema = z.object({
  date: z.string(),
  pnl: Amount,
  cumulative: Amount,
  drawdown: Amount,
  eligible: Count,
  missing: Count,
});
export type DailyPoint = z.infer<typeof DailyPointSchema>;
export const MonthlyRowSchema = GroupRowSchema.extend({
  month: z.string(),
  executions: Count,
  netCash: Amount,
});
const PositionSchema = z.object({
  instrumentKey: z.string(),
  quantity: z.string(),
});
export const AnalyticsStrategySchema = z.object({
  id: z.string(),
  type: z.string(),
  currency: z.string(),
  description: z.string(),
  openingDate: z.string().nullable(),
  closeDate: z.string().nullable(),
  expiry: z.string().nullable(),
  expiryYear: z.number().nullable(),
  status: z.enum(["open", "partially_closed", "closed", "unresolved"]),
  complete: z.boolean(),
  openingAmount: Amount,
  cashflow: Amount,
  brokerPnl: Amount,
  reconstructedPnl: Amount,
  positions: z.array(PositionSchema),
  reasons: z.array(z.string()),
});
export const AnalyticsExecutionSchema = z.object({
  key: z.string(),
  account: z.string(),
  instrument: z.object({
    key: z.string(),
    assetClass: z.string(),
    symbol: z.string(),
    underlying: z.string().nullable(),
    conid: z.string().nullable(),
    expiry: z.string().nullable(),
    strike: Amount,
    putCall: z.enum(["P", "C"]).nullable(),
    multiplier: Amount,
  }),
  date: z.string(),
  rawDateTime: z.string(),
  timezone: z.string().nullable(),
  quantity: z.string(),
  price: Amount,
  currency: z.string(),
  netCash: z.string(),
  proceeds: Amount,
  commission: Amount,
  taxes: Amount,
  basis: Amount,
  brokerPnl: Amount,
  action: z.enum(["open", "close", "mixed", "unknown"]),
  event: z.enum([
    "trade",
    "assignment",
    "exercise",
    "expiry",
    "cash_settlement",
    "unsupported",
  ]),
  brokerIds: z.record(z.string(), z.string()),
  codes: z.array(z.string()),
  sources: z.array(z.object({ importId: z.string(), rowNumber: Count })),
});
export const StrategyResultSchema = AnalyticsStrategySchema.extend({
  selectedPnl: Amount,
  underlying: z.string(),
  assetClass: z.string(),
});
export type StrategyResult = z.infer<typeof StrategyResultSchema>;
export const ProvenanceSchema = z.object({
  buildId: z.string().nullable(),
  ledgerId: z.string().nullable(),
  stale: z.boolean(),
  generatedAt: z.string(),
});
export const AnalyticsResponseSchema = ProvenanceSchema.extend({
  filters: AnalyticsQuerySchema,
  options: z.object({
    currencies: z.array(z.string()),
    symbols: z.array(z.string()),
    underlyings: z.array(z.object({ key: z.string(), label: z.string() })),
    strategyTypes: z.array(z.string()),
    assetClasses: z.array(z.string()),
  }),
  performance: PerformanceSummarySchema,
  transactions: TransactionSummarySchema,
  daily: z.array(DailyPointSchema),
  monthly: z.array(MonthlyRowSchema),
  byStrategyType: z.array(GroupRowSchema),
  byUnderlying: z.array(GroupRowSchema),
  recent: z.array(StrategyResultSchema),
  best: z.array(StrategyResultSchema),
  worst: z.array(StrategyResultSchema),
  quality: z.object({
    undatedClosed: Count,
    unresolved: Count,
    estimatedClosed: Count,
    excludedUnallocated: Count,
  }),
});
export type AnalyticsResponse = z.infer<typeof AnalyticsResponseSchema>;
const DetailMeta = {
  ...ProvenanceSchema.shape,
  page: Count,
  pageSize: Count,
  total: Count,
  filters: DetailQuerySchema,
};
export const AnalyticsDetailsResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    ...DetailMeta,
    kind: z.literal("strategies"),
    items: z.array(StrategyResultSchema),
  }),
  z.object({
    ...DetailMeta,
    kind: z.literal("transactions"),
    items: z.array(AnalyticsExecutionSchema),
  }),
]);
export type AnalyticsDetailsResponse = z.infer<
  typeof AnalyticsDetailsResponseSchema
>;

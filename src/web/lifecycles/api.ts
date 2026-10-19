import { z } from "zod";
import { AllocationRefSchema } from "../../shared/lifecycles.js";
import {
  BuildResponseSchema,
  DecisionResponseSchema,
  ExecutionSchema,
  IssueSchema,
  pollJob,
  requestJson,
  SourceRefSchema,
  StrategySchema,
} from "../api.js";
export const LifecycleSchema = StrategySchema.extend({
  account: z.string(),
  underlyingKey: z.string(),
  originStrategyType: z.string(),
  stage: z.enum(["options", "assigned_stock", "covered_call", "closed"]),
  campaignId: z.string().nullable(),
  coveredShares: z.string(),
  uncoveredShares: z.string(),
  componentIds: z.array(z.string()),
});
export const MemberSchema = z.object({
  lifecycleId: z.string(),
  allocation: AllocationRefSchema,
  quantity: z.string(),
  netCash: z.string(),
  brokerPnl: z.string().nullable(),
  estimated: z.boolean(),
  sources: z.array(SourceRefSchema),
});
export const SuggestionSchema = z.object({
  id: z.string(),
  callOpening: AllocationRefSchema,
  candidateLifecycleIds: z.array(z.string()),
  quantity: z.string(),
  sources: z.array(SourceRefSchema),
  reasons: z.array(z.string()),
});
export const CampaignSchema = z.object({
  id: z.string(),
  name: z.string(),
  account: z.string(),
  currency: z.string(),
  underlyingKey: z.string(),
  lifecycleIds: z.array(z.string()),
});
export const ValuationSchema = z.object({
  lifecycleId: z.string(),
  asOf: z.string().nullable(),
  source: z.literal("manual").nullable(),
  cashflow: z.string(),
  realizedBrokerPnl: z.string().nullable(),
  unrealizedPnl: z.string().nullable(),
  totalPnl: z.string().nullable(),
  estimated: z.boolean(),
  reasons: z.array(z.string()),
});
const Provenance = {
  buildId: z.string().nullable(),
  ledgerId: z.string().nullable(),
  stale: z.boolean(),
  generatedAt: z.string(),
  watermark: z.number(),
  rebuildRequired: z.boolean(),
};
export const LifecycleListSchema = z.object({
  ...Provenance,
  lifecycles: z
    .object({
      version: z.literal(1),
      lifecycles: z.array(LifecycleSchema),
      members: z.array(MemberSchema),
      campaigns: z.array(CampaignSchema),
      suggestions: z.array(SuggestionSchema),
      issues: z.array(IssueSchema),
      valuations: z.array(ValuationSchema),
    })
    .nullable(),
});
export const LifecycleDetailSchema = z.object({
  ...Provenance,
  lifecycle: LifecycleSchema,
  members: z.array(MemberSchema),
  executions: z.array(ExecutionSchema),
  suggestions: z.array(SuggestionSchema),
  valuation: ValuationSchema.nullable(),
  campaigns: z.array(CampaignSchema),
});
export type LifecycleDetailData = z.infer<typeof LifecycleDetailSchema>;
export type SaveDecision = (kind: string, payload: unknown) => Promise<void>;
export async function rebuildLifecycles(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { jobId } = await requestJson(
    "/api/builds",
    BuildResponseSchema,
    "POST",
    { mode: "projection" },
  );
  const job = await pollJob(jobId, undefined, signal ? { signal } : {});
  signal?.throwIfAborted();
  if (job.status !== "complete")
    throw new Error(
      job.error ??
        "The rebuild did not complete. Please retry from Maintenance.",
    );
}
/**
 * Appends one lifecycle decision. It does not rebuild: the caller rebuilds
 * separately, so a retry after a failed rebuild repeats only the rebuild. The
 * caller passes the same clientRequestId when it retries the same decision.
 */
export async function recordLifecycleDecision(
  watermark: number,
  kind: string,
  payload: unknown,
  supersedesId: string | null,
  clientRequestId: string,
) {
  await requestJson("/api/decisions", DecisionResponseSchema, "POST", {
    clientRequestId,
    author: "user",
    sources: [],
    strategyIds: [],
    supersedesId,
    expectedWatermark: watermark,
    kind,
    payload,
  });
}

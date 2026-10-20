import { z } from "zod";
import type { Id, Issue, SourceRef, Strategy } from "./domain.js";
export const DecimalTextSchema = z
  .string()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/);
export const AllocationRefSchema = z.object({
  strategyId: z.string().min(1),
  executionKey: z.string().min(1),
  role: z.enum(["open", "close"]),
});
export type AllocationRef = z.infer<typeof AllocationRefSchema>;
export interface LifecycleMember {
  lifecycleId: Id;
  allocation: AllocationRef;
  quantity: string;
  netCash: string;
  brokerPnl: string | null;
  estimated: boolean;
  sources: SourceRef[];
}
export interface Lifecycle extends Strategy {
  originOpeningExecutionKey?: string;
  account: string;
  underlyingKey: string;
  originStrategyType: string;
  stage: "options" | "assigned_stock" | "covered_call" | "closed";
  campaignId: Id | null;
  coveredShares: string;
  uncoveredShares: string;
  componentIds: Id[];
}
export interface AttachmentSuggestion {
  id: Id;
  callOpening: AllocationRef;
  candidateLifecycleIds: Id[];
  quantity: string;
  sources: SourceRef[];
  reasons: string[];
}
export interface WheelCampaign {
  id: Id;
  name: string;
  account: string;
  currency: string;
  underlyingKey: string;
  lifecycleIds: Id[];
}
export const ValuationSnapshotSchema = z.object({
  account: z.string().min(1),
  currency: z.string().min(1),
  asOf: z.iso.datetime({ offset: true }),
  marks: z
    .array(
      z.object({
        instrumentKey: z.string().min(1),
        price: DecimalTextSchema.refine(
          (v) => !v.startsWith("-"),
          "Price must be nonnegative.",
        ),
      }),
    )
    .min(1),
});
export type ValuationSnapshot = z.infer<typeof ValuationSnapshotSchema>;
export interface LifecycleValuation {
  lifecycleId: Id;
  asOf: string | null;
  source: "manual" | null;
  cashflow: string;
  realizedBrokerPnl: string | null;
  unrealizedPnl: string | null;
  totalPnl: string | null;
  estimated: boolean;
  reasons: string[];
}
export interface LifecycleProjection {
  version: 1;
  lifecycles: Lifecycle[];
  members: LifecycleMember[];
  campaigns: WheelCampaign[];
  suggestions: AttachmentSuggestion[];
  issues: Issue[];
  valuations: LifecycleValuation[];
}
export interface LifecycleAnchor {
  account: string;
  openingExecutionKey: string;
}
export interface RetainedLifecycleAnchor extends LifecycleAnchor {
  id: Id;
}
export const LifecycleAttachmentPayloadSchema = z.object({
  opening: AllocationRefSchema,
  targets: z
    .array(
      z.object({ lifecycleId: z.string().min(1), quantity: DecimalTextSchema }),
    )
    .min(1),
});
export const LifecycleMembershipPayloadSchema = z.object({
  requireCallCoverage: z.boolean().optional(),
  assignments: z
    .array(
      z.object({
        lifecycleId: z.string().min(1),
        allocation: AllocationRefSchema,
        quantity: DecimalTextSchema,
      }),
    )
    .min(1),
});
export const LifecycleRejectionPayloadSchema = z.object({
  callOpening: AllocationRefSchema,
  candidateLifecycleIds: z.array(z.string()).min(1),
  reason: z.string().min(1),
});
export const CampaignPayloadSchema = z.object({
  campaignId: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  account: z.string().min(1),
  currency: z.string().min(1),
  underlyingKey: z.string().min(1),
});
export const CampaignMembershipPayloadSchema = z.object({
  lifecycleId: z.string().min(1),
  campaignId: z.string().min(1).nullable(),
});

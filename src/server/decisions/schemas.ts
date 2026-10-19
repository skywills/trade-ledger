import { z } from "zod";
import type { Id, SourceRef } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import {
  CampaignMembershipPayloadSchema,
  CampaignPayloadSchema,
  LifecycleAttachmentPayloadSchema,
  LifecycleMembershipPayloadSchema,
  LifecycleRejectionPayloadSchema,
  ValuationSnapshotSchema,
} from "../../shared/lifecycles.js";

const DecimalText = z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/);

const IdSchema = z.string().min(1);
const SourceRefSchema = z.object({
  importId: IdSchema,
  rowNumber: z.number().int().positive(),
});

const CommonFields = {
  clientRequestId: z.string().min(1),
  sources: z.array(SourceRefSchema).default([]),
  strategyIds: z.array(IdSchema).default([]),
  supersedesId: IdSchema.nullable().default(null),
  author: z.string().min(1),
};

const NotesSchema = z.object({
  kind: z.literal("notes"),
  ...CommonFields,
  payload: z.object({
    strategyId: IdSchema,
    text: z.string().min(1),
  }),
});

const StopLossSchema = z.object({
  kind: z.literal("stop_loss"),
  ...CommonFields,
  payload: z.object({
    strategyId: IdSchema,
    price: DecimalText.refine(
      (price) => !price.startsWith("-") || !/[1-9]/.test(price),
      "Stop-loss price must be non-negative.",
    ),
  }),
});

const ManualAllocationRowSchema = z.object({
  executionKey: z.string().min(1),
  quantity: DecimalText,
  netCash: DecimalText,
  brokerPnl: DecimalText.nullable(),
});

const ManualAllocationSchema = z.object({
  kind: z.literal("manual_allocation"),
  ...CommonFields,
  payload: z.object({
    strategyId: IdSchema,
    source: SourceRefSchema,
    allocations: z.array(ManualAllocationRowSchema).min(1),
  }),
});

const IdentityBindingSchema = z.object({
  kind: z.literal("identity_binding"),
  ...CommonFields,
  payload: z.object({
    source: SourceRefSchema,
    canonicalIdentity: IdSchema,
    expectedQuantity: DecimalText,
  }),
});

const GroupExplicitSchema = z.object({
  kind: z.literal("group_explicit"),
  ...CommonFields,
  payload: z.object({
    strategyId: IdSchema,
    source: SourceRefSchema,
  }),
});

const GroupMergeSchema = z.object({
  kind: z.literal("group_merge"),
  ...CommonFields,
  payload: z.object({
    chosenStrategyId: IdSchema,
    mergedStrategyIds: z.array(IdSchema).min(1),
  }),
});

const GroupSplitSchema = z.object({
  kind: z.literal("group_split"),
  ...CommonFields,
  payload: z.object({
    parentStrategyId: IdSchema,
    childStrategyIds: z.array(IdSchema).min(1),
    notesOwnerStrategyId: IdSchema.nullable(),
  }),
});

const LifecycleSchema = z.object({
  kind: z.literal("lifecycle"),
  ...CommonFields,
  payload: z.object({
    event: z.enum(["assignment", "exercise", "expiry", "roll"]),
    sourceRef: SourceRefSchema,
    targetRef: SourceRefSchema,
  }),
});

const ExclusionSchema = z.object({
  kind: z.literal("import_exclusion"),
  ...CommonFields,
  payload: z.object({
    importId: IdSchema,
  }),
});

const ReinclusionSchema = z.object({
  kind: z.literal("import_inclusion"),
  ...CommonFields,
  payload: z.object({
    importId: IdSchema,
  }),
});

const RejectionSchema = z.object({
  kind: z.literal("rejection"),
  ...CommonFields,
  payload: z.object({
    evidenceHash: z.string().min(1),
    reason: z.string().optional(),
  }),
});

const LifecycleAttachmentSchema = z.object({
  kind: z.literal("lifecycle_attachment"),
  ...CommonFields,
  payload: LifecycleAttachmentPayloadSchema,
});
const LifecycleMembershipSchema = z.object({
  kind: z.literal("lifecycle_membership"),
  ...CommonFields,
  payload: LifecycleMembershipPayloadSchema,
});
const LifecycleRejectionSchema = z.object({
  kind: z.literal("lifecycle_attachment_rejection"),
  ...CommonFields,
  payload: LifecycleRejectionPayloadSchema,
});
const WheelCampaignSchema = z.object({
  kind: z.literal("wheel_campaign"),
  ...CommonFields,
  payload: CampaignPayloadSchema,
});
const WheelMembershipSchema = z.object({
  kind: z.literal("wheel_campaign_membership"),
  ...CommonFields,
  payload: CampaignMembershipPayloadSchema,
});
const LifecycleValuationSchema = z.object({
  kind: z.literal("lifecycle_valuation"),
  ...CommonFields,
  payload: ValuationSnapshotSchema,
});
export const DECISION_KINDS = [
  "lifecycle_attachment",
  "lifecycle_membership",
  "lifecycle_attachment_rejection",
  "wheel_campaign",
  "wheel_campaign_membership",
  "lifecycle_valuation",
  "notes",
  "stop_loss",
  "manual_allocation",
  "identity_binding",
  "group_explicit",
  "group_merge",
  "group_split",
  "lifecycle",
  "import_exclusion",
  "import_inclusion",
  "rejection",
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DecisionInputSchema = z.discriminatedUnion("kind", [
  LifecycleAttachmentSchema,
  LifecycleMembershipSchema,
  LifecycleRejectionSchema,
  WheelCampaignSchema,
  WheelMembershipSchema,
  LifecycleValuationSchema,
  NotesSchema,
  StopLossSchema,
  ManualAllocationSchema,
  IdentityBindingSchema,
  GroupExplicitSchema,
  GroupMergeSchema,
  GroupSplitSchema,
  LifecycleSchema,
  ExclusionSchema,
  ReinclusionSchema,
  RejectionSchema,
]);

export type DecisionInput = z.infer<typeof DecisionInputSchema>;

export type NotesInput = z.infer<typeof NotesSchema>;
export type StopLossInput = z.infer<typeof StopLossSchema>;
export type ManualAllocationInput = z.infer<typeof ManualAllocationSchema>;
export type IdentityBindingInput = z.infer<typeof IdentityBindingSchema>;
export type GroupExplicitInput = z.infer<typeof GroupExplicitSchema>;
export type GroupMergeInput = z.infer<typeof GroupMergeSchema>;
export type GroupSplitInput = z.infer<typeof GroupSplitSchema>;
export type LifecycleInput = z.infer<typeof LifecycleSchema>;
export type ExclusionInput = z.infer<typeof ExclusionSchema>;
export type ReinclusionInput = z.infer<typeof ReinclusionSchema>;
export type RejectionInput = z.infer<typeof RejectionSchema>;

export function notesInput(args: {
  strategyId: Id;
  text: string;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(NotesSchema, {
    kind: "notes",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [],
    strategyIds: [args.strategyId],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: { strategyId: args.strategyId, text: args.text },
  });
}

export function stopLossInput(args: {
  strategyId: Id;
  price: string;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(StopLossSchema, {
    kind: "stop_loss",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [],
    strategyIds: [args.strategyId],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: { strategyId: args.strategyId, price: args.price },
  });
}

export function manualAllocationInput(args: {
  strategyId: Id;
  source: SourceRef;
  allocations: Array<{
    executionKey: string;
    quantity: string;
    netCash: string;
    brokerPnl: string | null;
  }>;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(ManualAllocationSchema, {
    kind: "manual_allocation",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [args.source],
    strategyIds: [args.strategyId],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: {
      strategyId: args.strategyId,
      source: args.source,
      allocations: args.allocations,
    },
  });
}

export function identityBindingInput(args: {
  source: SourceRef;
  canonicalIdentity: Id;
  expectedQuantity: string;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(IdentityBindingSchema, {
    kind: "identity_binding",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [args.source],
    strategyIds: [args.canonicalIdentity],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: {
      source: args.source,
      canonicalIdentity: args.canonicalIdentity,
      expectedQuantity: args.expectedQuantity,
    },
  });
}

export function groupExplicitInput(args: {
  strategyId: Id;
  source: SourceRef;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(GroupExplicitSchema, {
    kind: "group_explicit",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [args.source],
    strategyIds: [args.strategyId],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: { strategyId: args.strategyId, source: args.source },
  });
}

export function groupMergeInput(args: {
  chosenStrategyId: Id;
  mergedStrategyIds: Id[];
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(GroupMergeSchema, {
    kind: "group_merge",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [],
    strategyIds: [args.chosenStrategyId, ...args.mergedStrategyIds],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: {
      chosenStrategyId: args.chosenStrategyId,
      mergedStrategyIds: args.mergedStrategyIds,
    },
  });
}

export function groupSplitInput(args: {
  parentStrategyId: Id;
  childStrategyIds: Id[];
  notesOwnerStrategyId: Id | null;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(GroupSplitSchema, {
    kind: "group_split",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [],
    strategyIds: [args.parentStrategyId, ...args.childStrategyIds],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: {
      parentStrategyId: args.parentStrategyId,
      childStrategyIds: args.childStrategyIds,
      notesOwnerStrategyId: args.notesOwnerStrategyId,
    },
  });
}

export function lifecycleInput(args: {
  event: "assignment" | "exercise" | "expiry" | "roll";
  source: SourceRef;
  target: SourceRef;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(LifecycleSchema, {
    kind: "lifecycle",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [args.source, args.target],
    strategyIds: [],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: {
      event: args.event,
      sourceRef: args.source,
      targetRef: args.target,
    },
  });
}

export function exclusionInput(args: {
  importId: Id;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(ExclusionSchema, {
    kind: "import_exclusion",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [],
    strategyIds: [],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: { importId: args.importId },
  });
}

export function reinclusionInput(args: {
  importId: Id;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(ReinclusionSchema, {
    kind: "import_inclusion",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [],
    strategyIds: [],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: { importId: args.importId },
  });
}

export function rejectionInput(args: {
  evidenceHash: string;
  reason?: string;
  clientRequestId?: string;
  supersedesId?: Id | null;
  author?: string;
}): DecisionInput {
  return parseOrThrow(RejectionSchema, {
    kind: "rejection",
    clientRequestId: args.clientRequestId ?? crypto.randomUUID(),
    sources: [],
    strategyIds: [],
    supersedesId: args.supersedesId ?? null,
    author: args.author ?? "user",
    payload: {
      evidenceHash: args.evidenceHash,
      reason: args.reason,
    },
  });
}

function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  payload: unknown,
): z.infer<S> {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new AppError(
      "INVALID_INPUT",
      `Decision input failed validation: ${result.error.message}`,
      400,
    );
  }
  return result.data as z.infer<S>;
}

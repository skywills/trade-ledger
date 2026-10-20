import { z } from "zod";
import type { Id } from "./domain.js";
import { AppError } from "./errors.js";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageParams {
  page: number;
  pageSize: number;
}

export type SortDirection = "asc" | "desc";

export interface SortSpec {
  key: string;
  direction: SortDirection;
}

/**
 * The exact envelope every paginated list endpoint returns. `buildId` and
 * `stale` are always present so the browser never has to guess which build a
 * page was served from; both are `null`/`false` when no generation is active.
 */
export interface ListEnvelope<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  buildId: Id | null;
  stale: boolean;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: unknown;
}

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.unknown()).optional(),
});

export const JobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  progress: z.string().nullable(),
  error: z.string().nullable(),
  input: z.unknown(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type JobDto = z.infer<typeof JobSchema>;

export const THINKING_LEVEL_VALUES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const ProfileModeSchema = z.enum(["local", "cloud"]);
export const ThinkingLevelSchema = z.enum(THINKING_LEVEL_VALUES);
export type ThinkingLevel = (typeof THINKING_LEVEL_VALUES)[number];

export const ProfilePricingSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
});

export const LlmProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: ProfileModeSchema,
  provider: z.string(),
  protocol: z.string(),
  endpoint: z.string(),
  modelId: z.string(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
  supportsTools: z.boolean(),
  thinkingLevels: z.array(ThinkingLevelSchema),
  credentialRef: z.string().nullable(),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  pricing: ProfilePricingSchema.nullable(),
});

export type LlmProfileDto = z.infer<typeof LlmProfileSchema>;

export const CredentialStatusSchema = z.object({
  ref: z.string().nullable(),
  kind: z.enum(["none", "env", "file"]),
  label: z.string(),
  configured: z.boolean(),
});

export const ProfileCompatibilitySchema = z.object({
  status: z.enum(["verified", "failed", "skipped", "unchecked"]),
  reason: z.string().nullable(),
  profileRevision: z.number().int().nullable(),
  checkedAt: z.string().nullable(),
  endpoint: z.string().nullable(),
  modelId: z.string().nullable(),
  durationMs: z.number().int().nullable(),
});

export const ModelProfileViewSchema = LlmProfileSchema.extend({
  credential: CredentialStatusSchema,
  compatibility: ProfileCompatibilitySchema,
});

export type ModelProfileView = z.infer<typeof ModelProfileViewSchema>;

export const ModelsResponseSchema = z.object({
  profiles: z.array(ModelProfileViewSchema),
  defaultProfileId: z.string().nullable(),
});

export const ProfileInputSchema = z.object({
  name: z.string().min(1),
  mode: ProfileModeSchema,
  provider: z.string().min(1),
  protocol: z.string().min(1),
  endpoint: z.string().min(1),
  modelId: z.string().min(1),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  timeoutSeconds: z.number().int().positive(),
  supportsTools: z.boolean(),
  thinkingLevels: z.array(ThinkingLevelSchema),
  credentialRef: z.string().nullable(),
  enabled: z.boolean().optional(),
  pricing: ProfilePricingSchema.nullable().optional(),
});

/** Portable settings only: no ids, checks, defaults, or resolved credentials. */
export const ModelConfigurationSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(ProfileInputSchema.strict()),
  })
  .strict();
export const ImportModelConfigurationResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
});
export const ResetPreviewSchema = z.object({
  imports: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  builds: z.number().int().nonnegative(),
});
export const ResetJournalBodySchema = z
  .object({ confirmation: z.literal("RESET") })
  .strict();
export const ResetJournalResponseSchema = z.object({ reset: z.literal(true) });

export const UpdateProfileSchema = ProfileInputSchema.extend({
  expectedRevision: z.number().int().positive(),
});

export const SaveProfileResponseSchema = z.object({
  profile: ModelProfileViewSchema,
});

export const SelectDefaultSchema = z.object({
  id: z.string().min(1),
  confirmCloud: z.boolean().optional(),
});

export const SelectDefaultResponseSchema = z.object({
  defaultProfileId: z.string().nullable(),
});

export const TestProfileSchema = z.object({
  result: ProfileCompatibilitySchema.extend({
    profileId: z.string(),
  }),
});

export type CompatibilityResultDto = z.infer<
  typeof TestProfileSchema
>["result"];

export const AnalysisStatusSchema = z.enum([
  "running",
  "proposal_ready",
  "failed",
  "cancelled",
  "accepted",
]);

export const RunSummarySchema = z.object({
  id: z.string(),
  status: AnalysisStatusSchema,
  createdAt: z.string(),
  threadId: z.string().nullable(),
  pendingProposals: z.number().int(),
});
export type RunSummaryDto = z.infer<typeof RunSummarySchema>;

export const ProposalDraftSchema = z.object({
  supersedesId: z.string().nullable().optional(),
  kind: z.string(),
  rationale: z.string().optional(),
  sources: z
    .array(z.object({ importId: z.string(), rowNumber: z.number().int() }))
    .optional(),
  strategyIds: z.array(z.string()).optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const SubmittedProposalSchema = z.object({
  id: z.string(),
  proposal: ProposalDraftSchema,
  submittedAt: z.string(),
  accepted: z.boolean(),
});

export const AnalysisRunSchema = z.object({
  id: z.string(),
  status: AnalysisStatusSchema,
  profileSnapshot: z
    .object({
      id: z.string(),
      name: z.string(),
      mode: z.string(),
      provider: z.string(),
      modelId: z.string(),
      revision: z.number().int(),
    })
    .loose(),
  evidence: z.object({
    buildId: z.string(),
    ledgerId: z.string(),
    contentHash: z.string(),
    watermark: z.number().int(),
    issueKeys: z.array(z.string()),
    rows: z.array(z.unknown()),
    rejected: z.array(z.unknown()),
  }),
  proposals: z.array(SubmittedProposalSchema),
  acceptedDecisionIds: z.array(z.string()),
  usage: z.record(z.string(), z.number()).nullable(),
  cost: z.number().nullable(),
  costSource: z.string().nullable(),
  error: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  threadId: z.string().nullable().default(null),
});

export type AnalysisRunDto = z.infer<typeof AnalysisRunSchema>;
export type SubmittedProposalDto = z.infer<typeof SubmittedProposalSchema>;

export const AnalysisEnvelopeSchema = z.object({ run: AnalysisRunSchema });

export const AcceptAnalysisResponseSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.string(),
      sequence: z.number().int(),
      kind: z.string(),
    }),
  ),
});

export const RejectAnalysisResponseSchema = z.object({
  decision: z.object({
    id: z.string(),
    sequence: z.number().int(),
    kind: z.string(),
  }),
});

export function listEnvelopeSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    total: z.number().int().min(0),
    buildId: z.string().nullable(),
    stale: z.boolean(),
  });
}

function invalid(message: string): AppError {
  return new AppError("INVALID_INPUT", message, 400);
}

function readBoundedInt(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw invalid(`${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(`${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

/** Parses and bounds the shared page/pageSize query parameters. */
export function parsePageParams(query: unknown): PageParams {
  const record = (query ?? {}) as Record<string, unknown>;
  return {
    page: readBoundedInt(record.page, "page", 1, Number.MAX_SAFE_INTEGER, 1),
    pageSize: readBoundedInt(
      record.pageSize,
      "pageSize",
      1,
      MAX_PAGE_SIZE,
      DEFAULT_PAGE_SIZE,
    ),
  };
}

/**
 * Parses a sort request against a fixed allowlist. The returned key always
 * comes from `allowed`, so downstream SQL never interpolates user input.
 */
export function parseSortSpec(
  query: unknown,
  allowed: readonly string[],
  fallbackKey: string,
): SortSpec {
  const record = (query ?? {}) as Record<string, unknown>;
  const rawKey = record.sort;
  let key = fallbackKey;
  if (rawKey !== undefined) {
    if (typeof rawKey !== "string" || !allowed.includes(rawKey)) {
      throw invalid(`Unknown sort key: ${String(rawKey)}.`);
    }
    key = rawKey;
  }
  const rawOrder = record.order;
  let direction: SortDirection = "asc";
  if (rawOrder !== undefined) {
    if (rawOrder !== "asc" && rawOrder !== "desc") {
      throw invalid("order must be asc or desc.");
    }
    direction = rawOrder;
  }
  return { key, direction };
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable in-memory sort driven by a fixed accessor allowlist. */
export function sortWithAllowlist<T>(
  items: readonly T[],
  spec: SortSpec,
  accessors: Record<string, (item: T) => string | number>,
): T[] {
  const accessor = accessors[spec.key];
  if (accessor === undefined) return [...items];
  const factor = spec.direction === "desc" ? -1 : 1;
  return [...items].sort(
    (left, right) => factor * compareValues(accessor(left), accessor(right)),
  );
}

export function pageSlice<T>(items: readonly T[], params: PageParams): T[] {
  const start = (params.page - 1) * params.pageSize;
  return items.slice(start, start + params.pageSize);
}

export function toEnvelope<T>(
  items: readonly T[],
  params: PageParams,
  total: number,
  buildId: Id | null,
  stale: boolean,
): ListEnvelope<T> {
  return {
    items: [...items],
    page: params.page,
    pageSize: params.pageSize,
    total,
    buildId,
    stale,
  };
}

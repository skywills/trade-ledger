import { z } from "zod";
import { AnalysisRunSchema, listEnvelopeSchema } from "./api.js";

export const UsageSchema = z.object({
  rounds: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  generatedTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
});
export const ThreadStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "limit_reached",
  "failed",
]);
export const PendingSchema = z.object({
  kind: z.enum(["approval", "question"]),
  requestId: z.string(),
  tool: z.string().nullable(),
  text: z.string(),
  expiresAt: z.string(),
});
export const AttachmentSchema = z.object({
  previewId: z.string().min(1).max(128),
  filename: z.string().min(1).max(260),
});
export const ToolRecordSchema = z.object({
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "done"]),
  isError: z.boolean(),
  approval: z.enum(["allowed", "denied", "expired", "cancelled"]).nullable(),
});
export const ChatThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  profileId: z.string().nullable(),
  modelRef: z.string(),
  cloudConfirmed: z.boolean(),
  status: ThreadStatusSchema,
  pending: PendingSchema.nullable(),
  seed: z.object({ issueKeys: z.array(z.string()) }).nullable(),
  usage: UsageSchema,
  cost: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ChatMessageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  attachments: z.array(AttachmentSchema),
  tools: z.array(ToolRecordSchema),
  status: z.enum(["complete", "streaming", "cancelled", "failed"]),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export const ThreadDetailSchema = z.object({
  thread: ChatThreadSchema,
  messages: z.array(ChatMessageSchema),
  runs: z.array(AnalysisRunSchema),
});
export const ThreadEnvelopeSchema = z.object({ thread: ChatThreadSchema });
export const ThreadsEnvelope = listEnvelopeSchema(ChatThreadSchema);
export const SendMessageResponseSchema = z.object({
  userMessageId: z.string(),
  assistantMessageId: z.string(),
});
export const AnswerResponseSchema = z.object({
  status: z.enum(["accepted", "expired", "cancelled", "unknown"]),
});
export const CancelResponseSchema = z.object({
  status: z.literal("cancelling"),
});

export const CreateThreadBodySchema = z
  .object({
    profileId: z.string().min(1).optional(),
    cloudConfirmed: z.boolean().optional(),
    seed: z
      .object({ issueKeys: z.array(z.string().min(1)).max(200) })
      .optional(),
  })
  .strict();
export const PatchThreadBodySchema = z
  .object({ title: z.string().trim().min(1).max(120) })
  .strict();
export const SendMessageBodySchema = z
  .object({
    clientMessageId: z.string().min(1).max(128),
    text: z.string().trim().min(1).max(8000),
    attachments: z.array(AttachmentSchema).max(20).optional(),
  })
  .strict();
export const AnswerBodySchema = z.union([
  z
    .object({
      requestId: z.string().min(1),
      decision: z.enum(["allow", "deny"]),
    })
    .strict(),
  z
    .object({ requestId: z.string().min(1), text: z.string().min(1).max(4096) })
    .strict(),
]);

export type ChatThreadDto = z.infer<typeof ChatThreadSchema>;
export type ChatMessageDto = z.infer<typeof ChatMessageSchema>;
export type ThreadDetailDto = z.infer<typeof ThreadDetailSchema>;
export type PendingDto = z.infer<typeof PendingSchema>;
export type ToolRecordDto = z.infer<typeof ToolRecordSchema>;
export type AttachmentDto = z.infer<typeof AttachmentSchema>;

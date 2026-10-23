import { z } from "zod";

const Amount = z.string().nullable();
export const PreviewTotalsSchema = z.object({
  strategyCount: z.number().int().nonnegative(),
  lifecycleCount: z.number().int().nonnegative().nullable(),
  unresolvedStrategies: z.number().int().nonnegative(),
  issueCounts: z.array(
    z.object({ code: z.string(), count: z.number().int().nonnegative() }),
  ),
  pnlByCurrency: z.array(
    z.object({
      currency: z.string(),
      brokerPnl: Amount,
      reconstructedPnl: Amount,
      missingBrokerPnl: z.number().int().nonnegative(),
      missingReconstructedPnl: z.number().int().nonnegative(),
    }),
  ),
});
export type PreviewTotals = z.infer<typeof PreviewTotalsSchema>;
export const ProposalPreviewSchema = z.object({
  valid: z.boolean(),
  buildId: z.string(),
  ledgerId: z.string(),
  watermark: z.number().int().nonnegative(),
  stale: z.literal(false),
  generatedAt: z.string(),
  issues: z.array(
    z.object({ code: z.string(), severity: z.enum(["warning", "error"]) }),
  ),
  blockingConnection: z
    .object({ date: z.string(), lifecycleId: z.string() })
    .optional(),
  impact: z
    .object({ before: PreviewTotalsSchema, after: PreviewTotalsSchema })
    .nullable(),
});
export type ProposalPreview = z.infer<typeof ProposalPreviewSchema>;

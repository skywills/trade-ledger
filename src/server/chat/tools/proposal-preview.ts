import { z } from "zod";
import { previewProposal } from "../../ai/proposal-preview.js";
import { ProposalSchema } from "../../ai/proposals.js";
import {
  type ChatTool,
  type ChatToolContext,
  jsonResult,
  refuseInvalidInput,
  UNTRUSTED,
} from "./shared.js";

const Query = z
  .object({
    proposal: ProposalSchema,
    expectedBuildId: z.string().min(1),
    expectedWatermark: z.number().int().nonnegative(),
  })
  .strict();
export function proposalPreviewTools(ctx: ChatToolContext): ChatTool[] {
  return [
    {
      name: "preview_proposal",
      description: `Validate one correction and compare hypothetical impact using a disposable database copy. No live journal data changes. Requires a current build and decision watermark; a later change invalidates the preview. P&L is per currency and missing values stay null with coverage. ${UNTRUSTED}`,
      inputSchema: z.toJSONSchema(Query, { io: "input", target: "draft-7" }),
      approval: "never",
      run: (input, runCtx) =>
        refuseInvalidInput(async () => {
          const q = Query.parse(input ?? {});
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
          timer.unref();
          try {
            return jsonResult(
              await previewProposal(
                ctx.store,
                q.proposal,
                { buildId: q.expectedBuildId, watermark: q.expectedWatermark },
                {
                  signal: AbortSignal.any([controller.signal, runCtx.signal]),
                  now: () => ctx.now(),
                },
              ),
            );
          } finally {
            clearTimeout(timer);
          }
        }),
    },
  ];
}

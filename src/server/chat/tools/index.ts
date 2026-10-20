import { analyticsTools } from "./analytics.js";
import { capabilitiesTool } from "./capabilities.js";
import { decisionHistoryTools } from "./decisions.js";
import { exportTools } from "./exports.js";
import { importEvidenceTools } from "./imports.js";
import { journalTools } from "./journal.js";
import { lifecycleTools } from "./lifecycles.js";
import { pnlTools } from "./pnl.js";
import { positionTools } from "./positions.js";
import { proposalPreviewTools } from "./proposal-preview.js";
import { proposalTools } from "./proposals.js";
import { guardReads, resetAfterWrite } from "./repeatGuard.js";
import { reviewTools } from "./review.js";
import type { ChatTool, ChatToolContext } from "./shared.js";
import { statusTools } from "./status.js";
import { writeTools } from "./writes.js";

/**
 * All chat tools. Read tools are guarded against repeated or runaway calls;
 * a successful write resets that guard so reads can see the new data.
 */
export function createChatTools(ctx: ChatToolContext): ChatTool[] {
  const reads = [
    ...decisionHistoryTools(ctx),
    ...proposalPreviewTools(ctx),
    ...analyticsTools(ctx),
    ...positionTools(ctx),
    ...exportTools(ctx),
    ...lifecycleTools(ctx),
    ...importEvidenceTools(ctx),
    ...pnlTools(ctx),
    ...journalTools(ctx),
    ...statusTools(ctx),
    ...reviewTools(ctx),
  ];
  const writes = writeTools(ctx);
  const proposals = proposalTools(ctx);
  const capabilities = capabilitiesTool(ctx, [
    ...reads,
    ...writes,
    ...proposals,
  ]);
  return [
    ...[...reads, capabilities].map((tool) => guardReads(ctx, tool)),
    ...writes.map((tool) => resetAfterWrite(ctx, tool)),
    ...proposals,
  ];
}

import { journalTools } from "./journal.js";
import { pnlTools } from "./pnl.js";
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
    ...pnlTools(ctx),
    ...journalTools(ctx),
    ...statusTools(ctx),
    ...reviewTools(ctx),
  ];
  return [
    ...reads.map((tool) => guardReads(ctx, tool)),
    ...writeTools(ctx).map((tool) => resetAfterWrite(ctx, tool)),
    ...proposalTools(ctx),
  ];
}

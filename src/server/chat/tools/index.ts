// src/server/chat/tools/index.ts
import { journalTools } from "./journal.js";
import { pnlTools } from "./pnl.js";
import { proposalTools } from "./proposals.js";
import type { ChatTool, ChatToolContext } from "./shared.js";
import { statusTools } from "./status.js";
import { writeTools } from "./writes.js";

/** All chat tools. Later tasks append write and proposal tools here. */
export function createChatTools(ctx: ChatToolContext): ChatTool[] {
  return [
    ...pnlTools(ctx),
    ...journalTools(ctx),
    ...statusTools(ctx),
    ...writeTools(ctx),
    ...proposalTools(ctx),
  ];
}

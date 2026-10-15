// src/server/chat/tools/index.ts
import { journalTools } from "./journal.js";
import { pnlTools } from "./pnl.js";
import type { ChatTool, ChatToolContext } from "./shared.js";
import { statusTools } from "./status.js";

/** All chat tools. Later tasks append write and proposal tools here. */
export function createChatTools(ctx: ChatToolContext): ChatTool[] {
  return [...pnlTools(ctx), ...journalTools(ctx), ...statusTools(ctx)];
}

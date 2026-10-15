import type { EmbedderToolResult } from "@nathapp/nax-agent";
import { type ChatTool, type ChatToolContext, errorResult } from "./shared.js";

/**
 * Stops a model from looping on read tools. Weak or confused models re-issue
 * the same call, or page one row at a time, until the turn limits cut them
 * off without an answer. Counts live per turn: they are keyed on
 * the turn id the service assigns at every turn start (copies of the turn
 * scope made mid-turn keep it), and a successful write clears them because
 * the data just changed.
 */
export const MAX_IDENTICAL_CALLS = 2;
export const MAX_CALLS_PER_TOOL = 30;

/** Status reads whose answer changes while a job runs; polling them is fine. */
const POLLING_TOOLS = new Set(["get_job", "get_build_status"]);

interface Counts {
  readonly identical: Map<string, number>;
  readonly perTool: Map<string, number>;
}

/** Per tool-context (one per live session): the turn being counted and its counts. */
const COUNTS = new WeakMap<
  ChatToolContext,
  { readonly turnId: string; readonly counts: Counts }
>();

function countsFor(ctx: ChatToolContext): Counts {
  const turnId = ctx.turn.current.turnId;
  const existing = COUNTS.get(ctx);
  if (existing !== undefined && existing.turnId === turnId) {
    return existing.counts;
  }
  const counts: Counts = { identical: new Map(), perTool: new Map() };
  COUNTS.set(ctx, { turnId, counts });
  return counts;
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` are the same call. */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function refusal(
  name: string,
  identical: number,
  perTool: number,
): EmbedderToolResult | null {
  if (identical > MAX_IDENTICAL_CALLS) {
    return errorResult(
      `You already called ${name} with this exact input ${MAX_IDENTICAL_CALLS} times in this turn. Answer from that result. If it is no longer in the conversation, summarise what you know and ask the user how to continue instead of calling again.`,
    );
  }
  if (perTool > MAX_CALLS_PER_TOOL) {
    return errorResult(
      `${name} has been called ${MAX_CALLS_PER_TOOL} times in this turn. Stop calling it: answer with what you have, or ask the user to narrow the question (for example a date range or status filter).`,
    );
  }
  return null;
}

function bump(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

/** Wraps a read tool so repeated or runaway calls are refused with guidance. */
export function guardReads(ctx: ChatToolContext, tool: ChatTool): ChatTool {
  if (POLLING_TOOLS.has(tool.name)) return tool;
  return {
    ...tool,
    run: (input, runCtx) => {
      const counts = countsFor(ctx);
      const identical = bump(
        counts.identical,
        `${tool.name}:${stableKey(input ?? {})}`,
      );
      const perTool = bump(counts.perTool, tool.name);
      const refused = refusal(tool.name, identical, perTool);
      return refused !== null
        ? Promise.resolve(refused)
        : tool.run(input, runCtx);
    },
  };
}

/** Wraps a write tool so a successful write lets reads see fresh data again. */
export function resetAfterWrite(
  ctx: ChatToolContext,
  tool: ChatTool,
): ChatTool {
  return {
    ...tool,
    run: async (input, runCtx) => {
      const result = await tool.run(input, runCtx);
      if (result.isError !== true) COUNTS.delete(ctx);
      return result;
    },
  };
}

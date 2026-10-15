import type { EmbedderToolResult } from "@nathapp/nax-agent";
import {
  type ChatTool,
  type ChatToolContext,
  errorResult,
  type TurnScope,
} from "./shared.js";

/**
 * Stops a model from looping on read tools. Weak or confused models re-issue
 * the same call, or page one row at a time, until the turn limits cut them
 * off without an answer. Counts live per turn: the service replaces
 * `ctx.turn.current` at every turn start, so keying on that object resets
 * them, and a successful write clears them because the data just changed.
 */
export const MAX_IDENTICAL_CALLS = 2;
export const MAX_CALLS_PER_TOOL = 15;

/** Status reads whose answer changes while a job runs; polling them is fine. */
const POLLING_TOOLS = new Set(["get_job", "get_build_status"]);

interface Counts {
  readonly identical: Map<string, number>;
  readonly perTool: Map<string, number>;
}

const COUNTS = new WeakMap<TurnScope, Counts>();

function countsFor(ctx: ChatToolContext): Counts {
  const scope = ctx.turn.current;
  const existing = COUNTS.get(scope);
  if (existing !== undefined) return existing;
  const created: Counts = { identical: new Map(), perTool: new Map() };
  COUNTS.set(scope, created);
  return created;
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
      `You already called ${name} with this exact input ${MAX_IDENTICAL_CALLS} times in this turn. Its result is earlier in the conversation; answer from it instead of calling again.`,
    );
  }
  if (perTool > MAX_CALLS_PER_TOOL) {
    return errorResult(
      `${name} has been called ${MAX_CALLS_PER_TOOL} times in this turn. Stop calling it and answer with what you have, or ask the user to narrow the question.`,
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
      if (result.isError !== true) COUNTS.delete(ctx.turn.current);
      return result;
    },
  };
}

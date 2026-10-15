import type { ToolRecordDto } from "../../shared/chat-api.js";

export type ChipTone = "running" | "ok" | "error" | "denied";

export interface ChipState {
  readonly label: string;
  readonly tone: ChipTone;
}

export interface ToolGroup {
  readonly key: string;
  readonly name: string;
  readonly gated: boolean;
  readonly state: ChipState;
  readonly count: number;
}

export function chipState(tool: ToolRecordDto): ChipState {
  if (
    tool.approval === "denied" ||
    tool.approval === "expired" ||
    tool.approval === "cancelled"
  ) {
    return { label: tool.approval, tone: "denied" };
  }
  if (tool.isError) return { label: "error", tone: "error" };
  if (tool.status === "running") return { label: "running", tone: "running" };
  return {
    label: tool.approval === "allowed" ? "allowed" : "done",
    tone: "ok",
  };
}

/**
 * One chip per tool name and outcome, in first-seen order. A weak model can
 * call the same read tool dozens of times; listing every call buries the reply.
 */
export function groupTools(tools: readonly ToolRecordDto[]): ToolGroup[] {
  const groups = new Map<string, ToolGroup>();
  for (const tool of tools) {
    const state = chipState(tool);
    const key = `${tool.name}\u0000${state.label}`;
    const current = groups.get(key);
    groups.set(
      key,
      current === undefined
        ? {
            key,
            name: tool.name,
            gated: tool.approval !== null,
            state,
            count: 1,
          }
        : { ...current, count: current.count + 1 },
    );
  }
  return [...groups.values()];
}

import { describe, expect, it } from "vitest";
import { groupTools } from "../../src/web/chat/toolGroups.js";

const tool = (
  callId: string,
  name: string,
  patch: Partial<{
    status: "running" | "done";
    isError: boolean;
    approval: "allowed" | "denied" | null;
  }> = {},
) => ({
  callId,
  name,
  status: "done" as const,
  isError: false,
  approval: null,
  ...patch,
});

describe("groupTools", () => {
  it("collapses repeated calls of the same tool and state into one chip with a count", () => {
    const groups = groupTools([
      tool("1", "list_strategies"),
      tool("2", "ScratchpadRead"),
      tool("3", "list_strategies"),
      tool("4", "list_strategies"),
    ]);
    expect(groups.map((g) => [g.name, g.state.label, g.count])).toEqual([
      ["list_strategies", "done", 3],
      ["ScratchpadRead", "done", 1],
    ]);
  });

  it("keeps different outcomes of the same tool apart, in first-seen order", () => {
    const groups = groupTools([
      tool("1", "rebuild", { approval: "denied" }),
      tool("2", "rebuild", { approval: "allowed" }),
      tool("3", "get_job", { status: "running" }),
      tool("4", "get_job", { isError: true }),
    ]);
    expect(groups.map((g) => `${g.name}:${g.state.label}:${g.count}`)).toEqual([
      "rebuild:denied:1",
      "rebuild:allowed:1",
      "get_job:running:1",
      "get_job:error:1",
    ]);
  });
});

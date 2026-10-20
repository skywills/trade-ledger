import type { EmbedderTool } from "@nathapp/nax-agent";
import { BuildScheduler } from "../../src/server/builds/service.js";
import type { ChatToolContext } from "../../src/server/chat/tools/shared.js";
import { JobService } from "../../src/server/jobs/service.js";
import type { Store } from "../../src/server/storage/database.js";

export function toolContext(store: Store): ChatToolContext {
  const jobs = new JobService(store);
  return {
    store,
    jobs,
    scheduler: new BuildScheduler(store, {}, jobs),
    thread: () => {
      throw new Error("No thread in read-tool test");
    },
    turn: {
      current: { turnId: "read-test", proposalRunId: null, proposalCount: 0 },
    },
    emitProposal: () => undefined,
    now: () => new Date("2026-10-20T00:00:00Z"),
  };
}

export async function callTool(
  tools: readonly EmbedderTool[],
  name: string,
  input: unknown = {},
) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.run(input, {
    sessionId: "test",
    toolCallId: "call",
    signal: new AbortController().signal,
  });
}

export async function toolJson(
  tools: readonly EmbedderTool[],
  name: string,
  input: unknown = {},
) {
  const result = await callTool(tools, name, input);
  if (result.isError) throw new Error(result.content);
  return JSON.parse(result.content);
}

import { describe, expect, it } from "vitest";
import { createReloader } from "../../src/web/chat/reloader.js";
import {
  applyFrame,
  initialThreadState,
  messageText,
  type ThreadState,
  withDetail,
} from "../../src/web/chat/threadController.js";

function firstMessage(state: ThreadState) {
  const message = state.detail?.messages[0];
  if (!message) throw new Error("expected a message");
  return message;
}

const detail = {
  thread: {
    id: "t",
    title: "x",
    profileId: null,
    modelRef: "m",
    cloudConfirmed: false,
    status: "running",
    pending: null,
    seed: null,
    usage: {
      rounds: 0,
      inputTokens: 0,
      outputTokens: 0,
      generatedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    cost: "0",
    createdAt: "",
    updatedAt: "",
  },
  messages: [
    {
      id: "m1",
      seq: 1,
      role: "assistant",
      content: "",
      attachments: [],
      tools: [],
      status: "streaming",
      error: null,
      createdAt: "",
    },
  ],
  runs: [],
} as const;

describe("threadController", () => {
  it("appends deltas and replaces text on reset", () => {
    let s = withDetail(initialThreadState(), detail as never);
    s = applyFrame(s, "delta", { messageId: "m1", text: "Hel" });
    s = applyFrame(s, "delta", { messageId: "m1", text: "lo" });
    expect(messageText(s, firstMessage(s))).toBe("Hello");
    s = applyFrame(s, "reset", { messageId: "m1", text: "He" });
    expect(messageText(s, firstMessage(s))).toBe("He");
  });

  it("tracks tool chips by callId without duplicates", () => {
    let s = withDetail(initialThreadState(), detail as never);
    s = applyFrame(s, "tool", {
      messageId: "m1",
      callId: "c",
      name: "list_imports",
      phase: "call",
    });
    s = applyFrame(s, "tool", {
      messageId: "m1",
      callId: "c",
      name: "list_imports",
      phase: "result",
      isError: false,
    });
    expect(s.liveTools.m1).toEqual([
      {
        callId: "c",
        name: "list_imports",
        status: "done",
        isError: false,
        approval: null,
      },
    ]);
  });

  it("shows and clears a pending approval", () => {
    let s = applyFrame(initialThreadState(), "approval", {
      requestId: "r",
      tool: "rebuild",
      summary: "Rebuild ledger (full)",
      expiresAt: "e",
    });
    expect(s.pending).toMatchObject({
      kind: "approval",
      requestId: "r",
      text: "Rebuild ledger (full)",
    });
    s = applyFrame(s, "resolved", { requestId: "r" });
    expect(s.pending).toBeNull();
  });

  it("asks for a refetch on message/thread/proposal and clears live state on new detail", () => {
    let s = withDetail(initialThreadState(), detail as never);
    s = applyFrame(s, "delta", { messageId: "m1", text: "x" });
    s = applyFrame(s, "message", { messageId: "m1" });
    expect(s.needsRefetch).toBe(true);
    s = withDetail(s, {
      ...detail,
      messages: [
        { ...detail.messages[0], status: "complete", content: "final" },
      ],
    } as never);
    expect(s.needsRefetch).toBe(false);
    expect(messageText(s, firstMessage(s))).toBe("final");
  });

  it("ignores malformed frames", () => {
    const s = applyFrame(initialThreadState(), "delta", { nope: 1 });
    expect(s).toEqual(initialThreadState());
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createReloader", () => {
  it("runs exactly one more fetch when reload is requested during an in-flight load", async () => {
    const pending: Array<ReturnType<typeof deferred<string>>> = [];
    const fetched: string[] = [];
    const applied: string[] = [];
    const reloader = createReloader<string>({
      fetch: (id) => {
        fetched.push(id);
        const d = deferred<string>();
        pending.push(d);
        return d.promise;
      },
      apply: (_id, value) => applied.push(value),
      fail: () => undefined,
    });
    reloader.activate("t");
    reloader.reload("t");
    reloader.reload("t");
    reloader.reload("t");
    expect(fetched).toEqual(["t"]);
    pending[0]?.resolve("first");
    await flush();
    expect(fetched).toEqual(["t", "t"]);
    pending[1]?.resolve("second");
    await flush();
    expect(applied).toEqual(["first", "second"]);
    expect(fetched).toHaveLength(2);
  });

  it("does not apply a response for a previous thread after switching", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    const applied: Array<[string, string]> = [];
    const reloader = createReloader<string>({
      fetch: (id) => {
        const d = deferred<string>();
        pending.set(id, d);
        return d.promise;
      },
      apply: (id, value) => applied.push([id, value]),
      fail: () => undefined,
    });
    reloader.activate("a");
    reloader.reload("a");
    reloader.activate("b");
    reloader.reload("b");
    pending.get("a")?.resolve("data-a");
    await flush();
    expect(applied).toEqual([]);
    pending.get("b")?.resolve("data-b");
    await flush();
    expect(applied).toEqual([["b", "data-b"]]);
  });
});

describe("withDetail error handling", () => {
  it("clears a previous error on a successful load", () => {
    const failed = { ...initialThreadState(), error: "boom" };
    const next = withDetail(failed, detail as never);
    expect(next.error).toBeNull();
  });
});

it("keeps tool error details from the live stream", () => {
  const state = applyFrame(initialThreadState(), "tool", {
    messageId: "m1",
    callId: "c",
    name: "submit_proposal",
    phase: "result",
    isError: true,
    error: "Proposal rejected: payload.source is required",
  });
  expect(state.liveTools.m1?.[0]).toMatchObject({
    error: "Proposal rejected: payload.source is required",
  });
});

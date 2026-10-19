import { describe, expect, it } from "vitest";
import { createReloader } from "../../src/web/chat/reloader.js";
import {
  applyFrame,
  beginReload,
  initialThreadState,
  messageText,
  messageThinking,
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
  it("restores snapshot text after a missed reset even when only newer tool events are replayed", () => {
    let s = withDetail(initialThreadState(), {
      ...detail,
      messages: [
        {
          ...detail.messages[0],
          streamRevision: 5,
          content: "Discarded old answer",
          thinking: "Discarded old thinking",
        },
      ],
    } as never);
    s = beginReload(s);
    s = applyFrame(s, "tool", {
      messageId: "m1",
      callId: "last",
      name: "get_strategy",
      phase: "result",
      revision: 11,
    });
    s = withDetail(s, {
      ...detail,
      messages: [
        {
          ...detail.messages[0],
          streamRevision: 10,
          content: "New",
          thinking: "Corrected",
        },
      ],
    } as never);
    expect(messageText(s, firstMessage(s))).toBe("New");
    expect(messageThinking(s, firstMessage(s))).toBe("Corrected");
    expect(s.liveTools.m1?.[0]?.callId).toBe("last");
  });

  it("joins a truncated replay tail to the full snapshot without losing its prefix", () => {
    let s = beginReload(initialThreadState());
    s = applyFrame(s, "thinking", {
      messageId: "m1",
      text: "trades",
      offset: 6,
      revision: 3,
    });
    s = applyFrame(s, "delta", {
      messageId: "m1",
      text: "world",
      offset: 6,
      revision: 4,
    });
    s = withDetail(s, {
      ...detail,
      messages: [
        {
          ...detail.messages[0],
          streamRevision: 2,
          content: "Hello ",
          thinking: "Check ",
        },
      ],
    } as never);
    expect(messageText(s, firstMessage(s))).toBe("Hello world");
    expect(messageThinking(s, firstMessage(s))).toBe("Check trades");
  });

  it("rejects snapshots and replay frames older than a retry, even when old text is longer", () => {
    const old = {
      ...detail,
      messages: [
        {
          ...detail.messages[0],
          streamRevision: 2,
          thinking: "Old discarded thinking",
          content: "Old discarded answer",
        },
      ],
    } as never;
    let s = beginReload(withDetail(initialThreadState(), old));
    s = applyFrame(s, "reset", { messageId: "m1", text: "", revision: 3 });
    s = applyFrame(s, "thinking_reset", {
      messageId: "m1",
      text: "",
      revision: 3,
    });
    s = withDetail(s, old);
    expect(messageThinking(s, firstMessage(s))).toBe("");
    expect(messageText(s, firstMessage(s))).toBe("");
    s = applyFrame(s, "thinking", {
      messageId: "m1",
      text: "Old discarded thinking",
      offset: 0,
      revision: 2,
    });
    expect(messageThinking(s, firstMessage(s))).toBe("");
    s = applyFrame(s, "thinking", {
      messageId: "m1",
      text: "New",
      offset: 0,
      revision: 4,
    });
    s = applyFrame(s, "delta", {
      messageId: "m1",
      text: "Fresh",
      offset: 0,
      revision: 5,
    });
    expect(messageThinking(s, firstMessage(s))).toBe("New");
    expect(messageText(s, firstMessage(s))).toBe("Fresh");
    // A reconnect's newer snapshot replaces a longer discarded local attempt.
    s = withDetail(s, {
      ...detail,
      messages: [
        { ...detail.messages[0], streamRevision: 6, thinking: "", content: "" },
      ],
    } as never);
    expect(messageThinking(s, firstMessage(s))).toBe("");
    expect(messageText(s, firstMessage(s))).toBe("");
  });

  it("keeps snapshot tool history when replay includes only the latest tool result", () => {
    const earlier = {
      callId: "first",
      name: "list_review_issues",
      status: "done",
      isError: false,
      approval: null,
    };
    let s = withDetail(initialThreadState(), {
      ...detail,
      messages: [
        { ...detail.messages[0], streamRevision: 2, tools: [earlier] },
      ],
    } as never);
    s = beginReload(s);
    s = applyFrame(s, "tool", {
      messageId: "m1",
      callId: "last",
      name: "get_strategy",
      phase: "result",
      revision: 4,
    });
    s = withDetail(s, {
      ...detail,
      messages: [
        {
          ...detail.messages[0],
          streamRevision: 3,
          tools: [
            earlier,
            {
              ...earlier,
              callId: "last",
              name: "get_strategy",
              status: "running",
            },
          ],
        },
      ],
    } as never);
    expect(s.liveTools.m1?.map((tool) => [tool.callId, tool.status])).toEqual([
      ["first", "done"],
      ["last", "done"],
    ]);
  });

  it("keeps thinking separate, survives running refetches and uses persisted thinking at completion", () => {
    let s = beginReload(withDetail(initialThreadState(), detail as never));
    s = applyFrame(s, "thinking", {
      messageId: "m1",
      text: "Checking ",
      offset: 0,
    });
    s = applyFrame(s, "thinking", {
      messageId: "m1",
      text: "trades",
      offset: 9,
    });
    s = applyFrame(s, "delta", { messageId: "m1", text: "Answer", offset: 0 });
    s = withDetail(s, detail as never);
    expect(messageThinking(s, firstMessage(s))).toBe("Checking trades");
    expect(messageText(s, firstMessage(s))).toBe("Answer");
    s = applyFrame(s, "thinking_reset", { messageId: "m1", text: "Checking " });
    expect(messageThinking(s, firstMessage(s))).toBe("Checking ");
    s = withDetail(s, {
      ...detail,
      messages: [
        {
          ...detail.messages[0],
          status: "complete",
          content: "Final",
          thinking: "Saved thinking",
        },
      ],
    } as never);
    expect(messageThinking(s, firstMessage(s))).toBe("Saved thinking");
  });

  it("does not duplicate replayed thinking or answer chunks after a REST snapshot", () => {
    let s = withDetail(initialThreadState(), {
      ...detail,
      messages: [
        { ...detail.messages[0], content: "Hello", thinking: "Check trades" },
      ],
    } as never);
    s = applyFrame(s, "thinking", {
      messageId: "m1",
      text: "Check ",
      offset: 0,
    });
    s = applyFrame(s, "delta", { messageId: "m1", text: "Hel", offset: 0 });
    s = applyFrame(s, "thinking", {
      messageId: "m1",
      text: "trades",
      offset: 6,
    });
    s = applyFrame(s, "delta", { messageId: "m1", text: "lo", offset: 3 });
    s = applyFrame(s, "thinking", { messageId: "m1", text: ".", offset: 12 });
    s = applyFrame(s, "delta", { messageId: "m1", text: "!", offset: 5 });
    expect(messageThinking(s, firstMessage(s))).toBe("Check trades.");
    expect(messageText(s, firstMessage(s))).toBe("Hello!");
  });

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

// test/unit/turn-accumulator.test.ts
import type { SessionEvent } from "@nathapp/nax-agent";
import { describe, expect, it } from "vitest";
import { TurnAccumulator } from "../../src/server/chat/accumulator.js";

const base = { sessionId: "s", turnId: "t", at: "x", metadata: {} };
const ev = (body: Record<string, unknown>) =>
  ({ ...base, ...body }) as SessionEvent;

describe("TurnAccumulator", () => {
  it("streams deltas and voids the current round on stream_reset", () => {
    const acc = new TurnAccumulator("m1");
    acc.apply(ev({ type: "text_delta", round: 1, text: "Hello " }));
    acc.apply(ev({ type: "text_delta", round: 2, text: "wrong" }));
    const frames = acc.apply(
      ev({ type: "stream_reset", round: 2, attempt: 1 }),
    );
    expect(frames).toEqual([
      { event: "reset", data: { messageId: "m1", text: "Hello " } },
    ]);
    acc.apply(ev({ type: "text_delta", round: 2, text: "world" }));
    expect(acc.text).toBe("Hello world");
  });

  it("uses turn_end.output as final content when completed", () => {
    const acc = new TurnAccumulator("m1");
    acc.apply(ev({ type: "text_delta", round: 1, text: "draft" }));
    acc.apply(
      ev({
        type: "turn_end",
        status: "completed",
        output: "Final",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      }),
    );
    expect(acc.finalContent()).toBe("Final");
    acc.apply(
      ev({
        type: "turn_end",
        status: "errored",
        output: "",
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
        error: { code: "X", message: "m" },
      }),
    );
    expect(acc.finalContent()).toBe("draft");
    expect(acc.end).toMatchObject({ status: "errored", errorCode: "X" });
  });

  it("tracks tools, approvals and their resolution", () => {
    const acc = new TurnAccumulator("m1");
    acc.apply(
      ev({ type: "tool_call", callId: "c1", name: "commit_import", input: {} }),
    );
    const asked = acc.apply(
      ev({
        type: "approval_requested",
        requestId: "r1",
        callId: "c1",
        tool: "commit_import",
        summary: "Commit x",
        reason: "r",
        expiresAt: "e",
      }),
    );
    expect(asked[0]).toEqual({
      event: "approval",
      data: {
        requestId: "r1",
        tool: "commit_import",
        summary: "Commit x",
        expiresAt: "e",
      },
    });
    expect(acc.pending).toMatchObject({ kind: "approval", requestId: "r1" });
    acc.apply(
      ev({
        type: "approval_resolved",
        requestId: "r1",
        decision: "deny",
        decidedBy: "timeout",
      }),
    );
    expect(acc.pending).toBeNull();
    expect(acc.tools[0]).toMatchObject({ callId: "c1", approval: "expired" });
    acc.apply(
      ev({
        type: "tool_result",
        callId: "c1",
        isError: true,
        preview: "Denied",
      }),
    );
    expect(acc.tools[0]).toMatchObject({ status: "done", isError: true });
  });

  it("ignores informational (answerable:false) approvals and questions", () => {
    const acc = new TurnAccumulator("m1");
    expect(
      acc.apply(
        ev({
          type: "question",
          requestId: "q",
          text: "?",
          expiresAt: "e",
          answerable: false,
        }),
      ),
    ).toEqual([]);
    expect(acc.pending).toBeNull();
  });
});

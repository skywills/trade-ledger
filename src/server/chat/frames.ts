// src/server/chat/frames.ts
import type { RunUsage } from "../ai/runs.js";
import type { ThreadStatus } from "./threads.js";

export type ChatFrame =
  | { event: "delta"; data: { messageId: string; text: string } }
  | { event: "reset"; data: { messageId: string; text: string } }
  | {
      event: "tool";
      data: {
        messageId: string;
        callId: string;
        name: string;
        phase: "call" | "result";
        isError?: boolean;
      };
    }
  | {
      event: "approval";
      data: {
        requestId: string;
        tool: string;
        summary: string;
        expiresAt: string;
      };
    }
  | {
      event: "question";
      data: { requestId: string; text: string; expiresAt: string };
    }
  | {
      event: "resolved";
      data: {
        requestId: string;
        decision?: "allow" | "deny";
        decidedBy?: string;
      };
    }
  | { event: "proposal"; data: { runId: string; proposalId: string } }
  | { event: "message"; data: { messageId: string } }
  | {
      event: "thread";
      data: { status: ThreadStatus; usage: RunUsage; cost: string };
    }
  | { event: "error"; data: { code: string; message: string } };

const MAX_REPLAY = 2000;

/** Per-thread fan-out. Replay covers the current turn only; clients refetch REST for history. */
export class ThreadEventBus {
  private readonly listeners = new Map<
    string,
    Set<(frame: ChatFrame) => void>
  >();
  private readonly replay = new Map<string, ChatFrame[]>();

  emit(threadId: string, frame: ChatFrame): void {
    const buffer = [...(this.replay.get(threadId) ?? []), frame].slice(
      -MAX_REPLAY,
    );
    this.replay.set(threadId, buffer);
    for (const listener of this.listeners.get(threadId) ?? []) {
      try {
        listener(frame);
      } catch {
        /* a listener must never break the turn */
      }
    }
  }

  resetReplay(threadId: string): void {
    this.replay.delete(threadId);
  }

  subscribe(
    threadId: string,
    listener: (frame: ChatFrame) => void,
  ): () => void {
    for (const frame of this.replay.get(threadId) ?? []) listener(frame);
    const set = this.listeners.get(threadId) ?? new Set();
    set.add(listener);
    this.listeners.set(threadId, set);
    return () => {
      set.delete(listener);
    };
  }
}

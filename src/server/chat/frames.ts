// src/server/chat/frames.ts
import { AppError } from "../../shared/errors.js";
import type { RunUsage } from "../ai/runs.js";
import type { ThreadStatus } from "./threads.js";

export type ChatFrame =
  | {
      event: "delta" | "thinking";
      data: {
        messageId: string;
        text: string;
        offset?: number;
        revision?: number;
      };
    }
  | {
      event: "reset";
      data: { messageId: string; text: string; revision?: number };
    }
  | {
      event: "thinking_reset";
      data: { messageId: string; text: string; revision?: number };
    }
  | {
      event: "tool";
      data: {
        messageId: string;
        callId: string;
        name: string;
        phase: "call" | "result";
        isError?: boolean;
        error?: string;
        revision?: number;
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
  | { event: "message"; data: { messageId: string; revision?: number } }
  | {
      event: "thread";
      data: { status: ThreadStatus; usage: RunUsage; cost: string };
    }
  | { event: "error"; data: { code: string; message: string } };

const MAX_REPLAY = 2000;
const MAX_REPLAY_BYTES = 256 * 1024;
const MAX_REPLAY_THREADS = 128;
const MAX_SUBSCRIBERS_PER_THREAD = 8;
const MAX_SUBSCRIBERS = 64;

interface Replay {
  frames: { frame: ChatFrame; bytes: number }[];
  start: number;
  length: number;
  bytes: number;
}
interface Subscriber {
  listener: (frame: ChatFrame) => void;
  close: (() => void) | undefined;
}

/** Bounded tail of the current turn; clients refetch REST for full history. */
export class ThreadEventBus {
  private readonly listeners = new Map<string, Set<Subscriber>>();
  private readonly replay = new Map<string, Replay>();
  private subscriberCount = 0;

  emit(threadId: string, frame: ChatFrame): void {
    const buffer = this.replay.get(threadId) ?? {
      frames: [],
      start: 0,
      length: 0,
      bytes: 0,
    };
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    while (
      buffer.length > 0 &&
      (buffer.length === MAX_REPLAY || buffer.bytes + bytes > MAX_REPLAY_BYTES)
    ) {
      buffer.bytes -= buffer.frames[buffer.start]?.bytes ?? 0;
      delete buffer.frames[buffer.start];
      buffer.start = (buffer.start + 1) % MAX_REPLAY;
      buffer.length -= 1;
    }
    if (bytes <= MAX_REPLAY_BYTES) {
      buffer.frames[(buffer.start + buffer.length) % MAX_REPLAY] = {
        frame,
        bytes,
      };
      buffer.length += 1;
      buffer.bytes += bytes;
    }
    // Refresh recency without copying the ring on each token.
    this.replay.delete(threadId);
    this.replay.set(threadId, buffer);
    if (this.replay.size > MAX_REPLAY_THREADS) {
      const oldest = this.replay.keys().next().value;
      if (oldest !== undefined) this.replay.delete(oldest);
    }
    for (const subscriber of this.listeners.get(threadId) ?? []) {
      try {
        subscriber.listener(frame);
      } catch {
        /* isolate listeners */
      }
    }
  }

  resetReplay(threadId: string): void {
    this.replay.delete(threadId);
  }

  clear(threadId: string): void {
    this.resetReplay(threadId);
    const subscribers = this.listeners.get(threadId);
    if (subscribers === undefined) return;
    this.subscriberCount -= subscribers.size;
    this.listeners.delete(threadId);
    const closing = [...subscribers];
    subscribers.clear();
    for (const subscriber of closing) {
      try {
        subscriber.close?.();
      } catch {
        /* isolate cleanup */
      }
    }
  }

  subscribe(
    threadId: string,
    listener: (frame: ChatFrame) => void,
    options: { replay?: boolean; onClose?: () => void } = {},
  ): () => void {
    const set = this.listeners.get(threadId) ?? new Set<Subscriber>();
    if (
      set.size >= MAX_SUBSCRIBERS_PER_THREAD ||
      this.subscriberCount >= MAX_SUBSCRIBERS
    )
      throw new AppError(
        "CHAT_STREAM_LIMIT",
        "Too many chat streams are open; close another tab and retry.",
        429,
      );
    const subscriber: Subscriber = { listener, close: options.onClose };
    set.add(subscriber);
    this.listeners.set(threadId, set);
    this.subscriberCount += 1;
    const release = () => {
      if (!set.delete(subscriber)) return;
      this.subscriberCount -= 1;
      if (set.size === 0) this.listeners.delete(threadId);
    };
    try {
      if (options.replay !== false) this.replayTo(threadId, listener);
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  replayTo(threadId: string, listener: (frame: ChatFrame) => void): void {
    const buffer = this.replay.get(threadId);
    if (buffer === undefined) return;
    for (let i = 0; i < buffer.length; i++) {
      const entry = buffer.frames[(buffer.start + i) % MAX_REPLAY];
      if (entry !== undefined) listener(entry.frame);
    }
  }
}

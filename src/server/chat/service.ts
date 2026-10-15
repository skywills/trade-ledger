// src/server/chat/service.ts
import { randomUUID } from "node:crypto";
import type { AnswerReply, AnswerStatus } from "@nathapp/nax-agent";
import type { Id } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type { SecretResolver } from "../ai/credentials.js";
import {
  DEFAULT_TURN_LIMITS,
  type HostedSession,
  modelRefFor,
  openHostedSession,
  resolveProfile,
  type TurnLimits,
} from "../ai/session-host.js";
import type { BuildScheduler } from "../builds/service.js";
import type { JobService } from "../jobs/service.js";
import type { Store } from "../storage/database.js";
import { TurnAccumulator } from "./accumulator.js";
import { ThreadEventBus } from "./frames.js";
import { buildInstructions } from "./instructions.js";
import {
  type Attachment,
  appendMessage,
  type ChatThread,
  createThread,
  findMessageByClientId,
  readThread,
  deleteThread as removeThread,
  updateMessage,
  updateThread,
} from "./threads.js";
import { createChatTools } from "./tools/index.js";
import type { TurnScope } from "./tools/shared.js";
import { runTurn } from "./turn.js";

export interface ChatLimits extends TurnLimits {
  readonly turnTimeoutSeconds: number;
  readonly approvalTimeoutMs: number;
  readonly maxThreadCostUsd: number;
  readonly maxThreadGeneratedTokens: number;
}

export const DEFAULT_CHAT_LIMITS: ChatLimits = {
  ...DEFAULT_TURN_LIMITS,
  turnTimeoutSeconds: 900,
  approvalTimeoutMs: 300_000,
  maxThreadCostUsd: 5,
  maxThreadGeneratedTokens: 1_000_000,
};
export const CHAT_SESSION_IDLE_MS = 15 * 60 * 1000;
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_ATTACHMENTS = 20;

export interface ChatServiceDeps {
  readonly store: Store;
  readonly secrets: SecretResolver;
  readonly scheduler: BuildScheduler;
  readonly jobs: JobService;
  readonly limits?: Partial<ChatLimits>;
  readonly now?: () => Date;
}

interface LiveThread {
  readonly hosted: HostedSession;
  readonly turn: { current: TurnScope };
  lastUsedAt: number;
  running: Promise<void> | null;
  accumulator: TurnAccumulator | null;
}

/** Process-wide registries so `shutdown(store)` can stop chats without an instance. */
const ACTIVE_CHATS = new Map<Id, LiveThread>();
const IN_FLIGHT = new Set<Promise<void>>();

export function cancelActiveChats(): void {
  for (const live of ACTIVE_CHATS.values()) {
    try {
      live.hosted.session.cancel("cancelled");
    } catch {
      /* already closed */
    }
  }
}

export async function drainActiveChats(): Promise<void> {
  await Promise.allSettled([...IN_FLIGHT]);
}

function busy(thread: ChatThread): boolean {
  return thread.status === "running" || thread.status === "waiting";
}

export class ChatService {
  readonly bus = new ThreadEventBus();
  private readonly limits: ChatLimits;
  private readonly now: () => Date;

  constructor(private readonly deps: ChatServiceDeps) {
    this.limits = { ...DEFAULT_CHAT_LIMITS, ...deps.limits };
    this.now = deps.now ?? (() => new Date());
  }

  async createThread(input: {
    profileId?: Id | null;
    cloudConfirmed?: boolean;
    seed?: { issueKeys: string[] } | null;
    title?: string;
  }): Promise<ChatThread> {
    const cloudConfirmed = input.cloudConfirmed === true;
    const profile = resolveProfile(this.deps.store, input.profileId ?? null, {
      cloudConfirmed,
    });
    return createThread(this.deps.store, {
      title: input.title ?? "New conversation",
      sessionId: `chat-${randomUUID()}`,
      profileId: profile.id,
      modelRef: modelRefFor(profile),
      cloudConfirmed,
      seed: input.seed ?? null,
      now: this.now(),
    });
  }

  async sendMessage(
    threadId: Id,
    input: {
      clientMessageId: string;
      text: string;
      attachments?: Attachment[];
    },
  ): Promise<{ userMessageId: Id; assistantMessageId: Id }> {
    const { store } = this.deps;
    const thread = this.requireThread(threadId);
    const existing = findMessageByClientId(
      store,
      threadId,
      input.clientMessageId,
    );
    if (existing !== null)
      return {
        userMessageId: existing.id,
        assistantMessageId: this.assistantAfter(threadId, existing.seq),
      };
    this.validateInput(input);
    if (busy(thread))
      throw new AppError(
        "THREAD_BUSY",
        "A reply is still in progress in this thread.",
        409,
      );
    if (thread.status === "limit_reached")
      throw new AppError(
        "THREAD_LIMIT_REACHED",
        "This thread reached its usage limit; start a new thread.",
        409,
      );
    const profile = resolveProfile(store, thread.profileId, {
      cloudConfirmed: thread.cloudConfirmed,
    });
    if (modelRefFor(profile) !== thread.modelRef) {
      throw new AppError(
        "THREAD_MODEL_CHANGED",
        "The profile's model changed since this thread started; start a new thread.",
        409,
      );
    }
    const attachments = input.attachments ?? [];
    const user = await appendMessage(store, threadId, {
      role: "user",
      content: input.text,
      attachments,
      status: "complete",
      clientMessageId: input.clientMessageId,
      now: this.now(),
    });
    const assistant = await appendMessage(store, threadId, {
      role: "assistant",
      content: "",
      attachments: [],
      status: "streaming",
      clientMessageId: null,
      now: this.now(),
    });
    const title = thread.nextSeq === 0 ? input.text.slice(0, 60) : undefined;
    const running = await updateThread(store, threadId, {
      status: "running",
      ...(title === undefined ? {} : { title }),
      now: this.now(),
    });
    this.bus.resetReplay(threadId);
    this.bus.emit(threadId, {
      event: "thread",
      data: { status: "running", usage: running.usage, cost: running.cost },
    });
    this.launch(running, assistant.id, this.prompt(input.text, attachments));
    return { userMessageId: user.id, assistantMessageId: assistant.id };
  }

  cancel(threadId: Id): void {
    ACTIVE_CHATS.get(threadId)?.hosted.session.cancel("cancelled");
  }

  answer(threadId: Id, requestId: string, reply: AnswerReply): AnswerStatus {
    const live = ACTIVE_CHATS.get(threadId);
    if (live === undefined || live.running === null) return "unknown";
    if ("text" in reply && (reply.text === "" || reply.text.length > 4096))
      return "unknown";
    let status: AnswerStatus;
    try {
      status = live.hosted.session.answer(requestId, reply);
    } catch {
      return "unknown";
    }
    if (status === "accepted" && "text" in reply && live.accumulator !== null) {
      for (const frame of live.accumulator.clearQuestion(requestId))
        this.bus.emit(threadId, frame);
      void updateThread(this.deps.store, threadId, {
        pending: null,
        status: "running",
        now: this.now(),
      }).catch(() => undefined);
    }
    return status;
  }

  async deleteThread(threadId: Id): Promise<void> {
    const thread = this.requireThread(threadId);
    if (busy(thread))
      throw new AppError(
        "THREAD_BUSY",
        "Stop the running reply before deleting this thread.",
        409,
      );
    await this.closeLive(threadId);
    await removeThread(this.deps.store, threadId);
  }

  async sweepIdle(idleMs: number = CHAT_SESSION_IDLE_MS): Promise<void> {
    const cutoff = Date.now() - idleMs;
    for (const [id, live] of ACTIVE_CHATS) {
      if (live.running === null && live.lastUsedAt <= cutoff)
        await this.closeLive(id);
    }
  }

  async close(): Promise<void> {
    cancelActiveChats();
    await drainActiveChats();
    for (const id of [...ACTIVE_CHATS.keys()]) await this.closeLive(id);
  }

  private launch(
    thread: ChatThread,
    assistantMessageId: Id,
    prompt: string,
  ): void {
    const work = this.executeTurn(thread, assistantMessageId, prompt);
    IN_FLIGHT.add(work);
    void work.finally(() => IN_FLIGHT.delete(work));
  }

  private async executeTurn(
    thread: ChatThread,
    assistantMessageId: Id,
    prompt: string,
  ): Promise<void> {
    let live: LiveThread | null = null;
    try {
      live = await this.liveFor(thread);
      live.turn.current = { proposalRunId: null, proposalCount: 0 };
      live.accumulator = new TurnAccumulator(assistantMessageId);
      const run = runTurn({
        store: this.deps.store,
        bus: this.bus,
        session: live.hosted.session,
        thread,
        assistantMessageId,
        prompt,
        limits: this.limits,
        accumulator: live.accumulator,
        now: this.now,
      });
      live.running = run;
      await run;
    } catch (error) {
      await this.failBeforeTurn(thread, assistantMessageId, error);
      await this.closeLive(thread.id);
    } finally {
      if (live !== null) {
        live.running = null;
        live.accumulator = null;
        live.lastUsedAt = Date.now();
      }
    }
  }

  private async liveFor(thread: ChatThread): Promise<LiveThread> {
    const cached = ACTIVE_CHATS.get(thread.id);
    if (cached !== undefined) return cached;
    const profile = resolveProfile(this.deps.store, thread.profileId, {
      cloudConfirmed: thread.cloudConfirmed,
    });
    const turn: { current: TurnScope } = {
      current: { proposalRunId: null, proposalCount: 0 },
    };
    const tools = createChatTools({
      store: this.deps.store,
      scheduler: this.deps.scheduler,
      jobs: this.deps.jobs,
      thread: () => readThread(this.deps.store, thread.id) ?? thread,
      turn,
      emitProposal: (runId, proposalId) =>
        this.bus.emit(thread.id, {
          event: "proposal",
          data: { runId, proposalId },
        }),
      now: this.now,
    });
    const hosted = await openHostedSession({
      store: this.deps.store,
      profile,
      secrets: this.deps.secrets,
      sessionId: thread.sessionId,
      instructions: buildInstructions(thread),
      tools,
      transcriptsSubdir: "chat",
      turnTimeoutSeconds: this.limits.turnTimeoutSeconds,
      approvalTimeoutMs: this.limits.approvalTimeoutMs,
      metadata: { threadId: thread.id },
    });
    const live: LiveThread = {
      hosted,
      turn,
      lastUsedAt: Date.now(),
      running: null,
      accumulator: null,
    };
    ACTIVE_CHATS.set(thread.id, live);
    return live;
  }

  private async failBeforeTurn(
    thread: ChatThread,
    assistantMessageId: Id,
    error: unknown,
  ): Promise<void> {
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : String(error);
    const reason =
      code === "AGENT_SESSION_MODEL_MISMATCH"
        ? "THREAD_MODEL_CHANGED"
        : typeof code === "string"
          ? code
          : "SESSION_FAILED";
    await updateMessage(this.deps.store, assistantMessageId, {
      status: "failed",
      error: reason,
    }).catch(() => undefined);
    const saved = await updateThread(this.deps.store, thread.id, {
      status: "idle",
      pending: null,
      now: this.now(),
    }).catch(() => thread);
    this.bus.emit(thread.id, {
      event: "error",
      data: { code: reason, message },
    });
    this.bus.emit(thread.id, {
      event: "message",
      data: { messageId: assistantMessageId },
    });
    this.bus.emit(thread.id, {
      event: "thread",
      data: { status: saved.status, usage: saved.usage, cost: saved.cost },
    });
  }

  private async closeLive(threadId: Id): Promise<void> {
    const live = ACTIVE_CHATS.get(threadId);
    if (live === undefined) return;
    ACTIVE_CHATS.delete(threadId);
    await live.hosted.close();
  }

  private requireThread(threadId: Id): ChatThread {
    const thread = readThread(this.deps.store, threadId);
    if (thread === null)
      throw new AppError(
        "THREAD_NOT_FOUND",
        `No chat thread exists for id ${threadId}.`,
        404,
      );
    return thread;
  }

  private assistantAfter(threadId: Id, seq: number): Id {
    const row = this.deps.store.db
      .prepare("SELECT id FROM chat_messages WHERE thread_id = ? AND seq = ?")
      .get(threadId, seq + 1) as { id: string } | undefined;
    return row?.id ?? "";
  }

  private validateInput(input: {
    clientMessageId: string;
    text: string;
    attachments?: Attachment[];
  }): void {
    if (input.clientMessageId === "" || input.clientMessageId.length > 128)
      throw new AppError(
        "INVALID_INPUT",
        "clientMessageId must be 1..128 characters.",
        400,
      );
    if (input.text.trim() === "" || input.text.length > MAX_MESSAGE_CHARS)
      throw new AppError(
        "INVALID_INPUT",
        `text must be 1..${MAX_MESSAGE_CHARS} characters.`,
        400,
      );
    if ((input.attachments ?? []).length > MAX_ATTACHMENTS)
      throw new AppError(
        "INVALID_INPUT",
        `At most ${MAX_ATTACHMENTS} attachments are allowed.`,
        400,
      );
  }

  private prompt(text: string, attachments: readonly Attachment[]): string {
    if (attachments.length === 0) return text;
    const list = attachments
      .map((a) => `${a.previewId} (${a.filename})`)
      .join(", ");
    return `Attached import previews: ${list}\n\n${text}`;
  }
}

// src/server/chat/accumulator.ts
import type { SessionEvent, TurnEndStatus } from "@nathapp/nax-agent";
import type { ChatFrame } from "./frames.js";
import type { PendingInteraction, ToolRecord } from "./threads.js";

export interface TurnEnd {
  readonly status: TurnEndStatus;
  readonly output: string;
  readonly errorCode: string | null;
}

const APPROVAL_LABEL = { timeout: "expired", cancelled: "cancelled" } as const;

/** Folds one turn's SessionEvents into message state and SSE frames. Pure; no I/O. */
export class TurnAccumulator {
  private committed = "";
  private current = "";
  private committedThinking = "";
  private currentThinking = "";
  private round = 0;
  private version = 0;
  private toolList: ToolRecord[] = [];
  private pendingAsk: PendingInteraction | null = null;
  private approvalCalls = new Map<string, string>();
  private ended: TurnEnd | null = null;

  constructor(private readonly messageId: string) {}

  get text(): string {
    return this.committed + this.current;
  }
  get tools(): ToolRecord[] {
    return this.toolList;
  }
  get thinking(): string {
    return this.committedThinking + this.currentThinking;
  }
  get revision(): number {
    return this.version;
  }
  get pending(): PendingInteraction | null {
    return this.pendingAsk;
  }
  get end(): TurnEnd | null {
    return this.ended;
  }

  finalContent(): string {
    return this.ended?.status === "completed" && this.ended.output !== ""
      ? this.ended.output
      : this.text;
  }

  apply(event: SessionEvent): ChatFrame[] {
    this.version += 1;
    return this.applyEvent(event).map((frame) => {
      if ("messageId" in frame.data) frame.data.revision = this.version;
      return frame;
    });
  }

  private applyEvent(event: SessionEvent): ChatFrame[] {
    switch (event.type) {
      case "text_delta":
        return this.delta(event.round, event.text);
      case "thinking_delta":
        return this.delta(event.round, event.text, true);
      case "stream_reset":
        this.startRound(event.round);
        this.current = "";
        this.currentThinking = "";
        return [
          {
            event: "reset",
            data: { messageId: this.messageId, text: this.text },
          },
          {
            event: "thinking_reset",
            data: { messageId: this.messageId, text: this.thinking },
          },
        ];
      case "tool_call":
        return this.toolCalled(event);
      case "tool_result":
        return this.toolResulted(event);
      case "approval_requested":
        return this.approvalRequested(event);
      case "approval_resolved":
        return this.resolved(event.requestId, event.decision, event.decidedBy);
      case "question":
        return this.questionAsked(event);
      case "turn_end":
        this.ended = {
          status: event.status,
          output: event.output,
          errorCode: event.error?.code ?? null,
        };
        this.pendingAsk = null;
        return [];
      default:
        return [];
    }
  }

  private toolCalled(
    event: Extract<SessionEvent, { type: "tool_call" }>,
  ): ChatFrame[] {
    this.toolList = [
      ...this.toolList,
      {
        callId: event.callId,
        name: event.name,
        status: "running",
        isError: false,
        approval: null,
      },
    ];
    return [
      {
        event: "tool",
        data: {
          messageId: this.messageId,
          callId: event.callId,
          name: event.name,
          phase: "call",
        },
      },
    ];
  }

  private toolResulted(
    event: Extract<SessionEvent, { type: "tool_result" }>,
  ): ChatFrame[] {
    const error = event.isError ? event.preview : undefined;
    this.patchTool(event.callId, {
      status: "done",
      isError: event.isError,
      ...(error === undefined ? {} : { error }),
    });
    return [
      {
        event: "tool",
        data: {
          messageId: this.messageId,
          callId: event.callId,
          name: this.toolName(event.callId),
          phase: "result",
          isError: event.isError,
          ...(error === undefined ? {} : { error }),
        },
      },
    ];
  }

  private approvalRequested(
    event: Extract<SessionEvent, { type: "approval_requested" }>,
  ): ChatFrame[] {
    if (event.answerable === false) return [];
    if (event.callId !== undefined)
      this.approvalCalls.set(event.requestId, event.callId);
    this.pendingAsk = {
      kind: "approval",
      requestId: event.requestId,
      tool: event.tool,
      text: event.summary,
      expiresAt: event.expiresAt,
    };
    return [
      {
        event: "approval",
        data: {
          requestId: event.requestId,
          tool: event.tool,
          summary: event.summary,
          expiresAt: event.expiresAt,
        },
      },
    ];
  }

  private questionAsked(
    event: Extract<SessionEvent, { type: "question" }>,
  ): ChatFrame[] {
    if (event.answerable === false) return [];
    this.pendingAsk = {
      kind: "question",
      requestId: event.requestId,
      tool: null,
      text: event.text,
      expiresAt: event.expiresAt,
    };
    return [
      {
        event: "question",
        data: {
          requestId: event.requestId,
          text: event.text,
          expiresAt: event.expiresAt,
        },
      },
    ];
  }

  /** A question answered through the service (there is no `question_resolved` event). */
  clearQuestion(requestId: string): ChatFrame[] {
    if (this.pendingAsk?.requestId !== requestId) return [];
    this.pendingAsk = null;
    return [{ event: "resolved", data: { requestId } }];
  }

  private startRound(round: number): void {
    if (round !== this.round) {
      this.committed += this.current;
      this.committedThinking += this.currentThinking;
      this.current = "";
      this.currentThinking = "";
      this.round = round;
    }
  }

  private delta(round: number, text: string, thinking = false): ChatFrame[] {
    this.startRound(round);
    const offset = thinking ? this.thinking.length : this.text.length;
    if (thinking) this.currentThinking += text;
    else this.current += text;
    return [
      {
        event: thinking ? "thinking" : "delta",
        data: { messageId: this.messageId, text, offset },
      },
    ];
  }

  private resolved(
    requestId: string,
    decision: "allow" | "deny",
    decidedBy: string,
  ): ChatFrame[] {
    const callId = this.approvalCalls.get(requestId);
    const label =
      decidedBy === "human"
        ? decision === "allow"
          ? "allowed"
          : "denied"
        : (APPROVAL_LABEL[decidedBy as keyof typeof APPROVAL_LABEL] ??
          "denied");
    if (callId !== undefined) this.patchTool(callId, { approval: label });
    if (this.pendingAsk?.requestId === requestId) this.pendingAsk = null;
    return [{ event: "resolved", data: { requestId, decision, decidedBy } }];
  }

  private patchTool(callId: string, patch: Partial<ToolRecord>): void {
    this.toolList = this.toolList.map((t) =>
      t.callId === callId ? { ...t, ...patch } : t,
    );
  }

  private toolName(callId: string): string {
    return this.toolList.find((t) => t.callId === callId)?.name ?? "unknown";
  }
}

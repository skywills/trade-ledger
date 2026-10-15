import { z } from "zod";
import type {
  ChatMessageDto,
  PendingDto,
  ThreadDetailDto,
  ToolRecordDto,
} from "../../shared/chat-api.js";

export interface ThreadState {
  readonly detail: ThreadDetailDto | null;
  readonly live: Readonly<Record<string, string>>;
  readonly liveTools: Readonly<Record<string, ToolRecordDto[]>>;
  readonly pending: PendingDto | null;
  readonly error: string | null;
  readonly needsRefetch: boolean;
}

export function initialThreadState(): ThreadState {
  return {
    detail: null,
    live: {},
    liveTools: {},
    pending: null,
    error: null,
    needsRefetch: false,
  };
}

/** Fresh REST state is authoritative: drop provisional deltas and chips. */
export function withDetail(
  state: ThreadState,
  detail: ThreadDetailDto,
): ThreadState {
  return {
    ...state,
    detail,
    live: {},
    liveTools: {},
    pending: detail.thread.pending,
    needsRefetch: false,
  };
}

const Delta = z.object({ messageId: z.string(), text: z.string() });
const Tool = z.object({
  messageId: z.string(),
  callId: z.string(),
  name: z.string(),
  phase: z.enum(["call", "result"]),
  isError: z.boolean().optional(),
});
const Approval = z.object({
  requestId: z.string(),
  tool: z.string(),
  summary: z.string(),
  expiresAt: z.string(),
});
const Question = z.object({
  requestId: z.string(),
  text: z.string(),
  expiresAt: z.string(),
});
const Resolved = z.object({ requestId: z.string() });
const ErrorFrame = z.object({ code: z.string(), message: z.string() });

type ToolFrame = z.infer<typeof Tool>;

function upsertTool(
  list: readonly ToolRecordDto[],
  frame: ToolFrame,
): ToolRecordDto[] {
  const status = frame.phase === "call" ? "running" : "done";
  const isError = frame.isError ?? false;
  const exists = list.some((t) => t.callId === frame.callId);
  if (!exists) {
    return [
      ...list,
      {
        callId: frame.callId,
        name: frame.name,
        status,
        isError,
        approval: null,
      },
    ];
  }
  return list.map((t) =>
    t.callId === frame.callId ? { ...t, name: frame.name, status, isError } : t,
  );
}

function applyDelta(
  state: ThreadState,
  data: unknown,
  replace: boolean,
): ThreadState {
  const f = Delta.safeParse(data);
  if (!f.success) return state;
  const previous = replace ? "" : (state.live[f.data.messageId] ?? "");
  return {
    ...state,
    live: { ...state.live, [f.data.messageId]: previous + f.data.text },
  };
}

function applyTool(state: ThreadState, data: unknown): ThreadState {
  const f = Tool.safeParse(data);
  if (!f.success) return state;
  const messageId = f.data.messageId;
  return {
    ...state,
    liveTools: {
      ...state.liveTools,
      [messageId]: upsertTool(state.liveTools[messageId] ?? [], f.data),
    },
  };
}

function applyApproval(state: ThreadState, data: unknown): ThreadState {
  const f = Approval.safeParse(data);
  if (!f.success) return state;
  const pending: PendingDto = {
    kind: "approval",
    requestId: f.data.requestId,
    tool: f.data.tool,
    text: f.data.summary,
    expiresAt: f.data.expiresAt,
  };
  return { ...state, pending };
}

function applyQuestion(state: ThreadState, data: unknown): ThreadState {
  const f = Question.safeParse(data);
  if (!f.success) return state;
  const pending: PendingDto = {
    kind: "question",
    requestId: f.data.requestId,
    tool: null,
    text: f.data.text,
    expiresAt: f.data.expiresAt,
  };
  return { ...state, pending };
}

function applyResolved(state: ThreadState, data: unknown): ThreadState {
  const f = Resolved.safeParse(data);
  return f.success && state.pending?.requestId === f.data.requestId
    ? { ...state, pending: null }
    : state;
}

function applyError(state: ThreadState, data: unknown): ThreadState {
  const f = ErrorFrame.safeParse(data);
  return f.success
    ? { ...state, error: f.data.message, needsRefetch: true }
    : state;
}

export function applyFrame(
  state: ThreadState,
  event: string,
  data: unknown,
): ThreadState {
  switch (event) {
    case "delta":
      return applyDelta(state, data, false);
    case "reset":
      return applyDelta(state, data, true);
    case "tool":
      return applyTool(state, data);
    case "approval":
      return applyApproval(state, data);
    case "question":
      return applyQuestion(state, data);
    case "resolved":
      return applyResolved(state, data);
    case "error":
      return applyError(state, data);
    case "message":
    case "thread":
    case "proposal":
      return { ...state, needsRefetch: true };
    default:
      return state;
  }
}

export function messageText(
  state: ThreadState,
  message: ChatMessageDto,
): string {
  return message.status === "streaming"
    ? (state.live[message.id] ?? message.content)
    : message.content;
}

export function messageTools(
  state: ThreadState,
  message: ChatMessageDto,
): ToolRecordDto[] {
  return message.status === "streaming"
    ? (state.liveTools[message.id] ?? message.tools)
    : message.tools;
}

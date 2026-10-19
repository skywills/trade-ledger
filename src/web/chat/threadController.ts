import { z } from "zod";
import type {
  ChatMessageDto,
  PendingDto,
  ThreadDetailDto,
  ToolRecordDto,
} from "../../shared/chat-api.js";

export interface ThreadState {
  readonly detail: ThreadDetailDto | null;
  readonly bufferedFrames: ReadonlyArray<{
    event: string;
    data: unknown;
  }> | null;
  readonly live: Readonly<Record<string, string>>;
  readonly liveRevision: Readonly<Record<string, number>>;
  readonly liveThinking: Readonly<Record<string, string>>;
  readonly liveTools: Readonly<Record<string, ToolRecordDto[]>>;
  readonly pending: PendingDto | null;
  readonly error: string | null;
  readonly needsRefetch: boolean;
}

export function initialThreadState(): ThreadState {
  return {
    detail: null,
    bufferedFrames: null,
    live: {},
    liveThinking: {},
    liveRevision: {},
    liveTools: {},
    pending: null,
    error: null,
    needsRefetch: false,
  };
}

/** Buffer only events arriving during a REST request, so an older snapshot
 * can be brought forward without guessing freshness from text lengths. */
export function beginReload(state: ThreadState): ThreadState {
  return { ...state, bufferedFrames: [] };
}

export function withDetail(
  state: ThreadState,
  detail: ThreadDetailDto,
): ThreadState {
  let next: ThreadState = {
    ...state,
    detail,
    live: {},
    liveThinking: {},
    liveTools: {},
    liveRevision: Object.fromEntries(
      detail.messages.map((m) => [m.id, m.streamRevision ?? 0]),
    ),
    bufferedFrames: null,
    pending: detail.thread.pending,
    error: null,
    needsRefetch: false,
  };
  for (const frame of state.bufferedFrames ?? []) {
    const version = VersionedFrame.safeParse(frame.data);
    const snapshot = version.success
      ? next.detail?.messages.find((m) => m.id === version.data.messageId)
      : undefined;
    if (
      version.success &&
      snapshot?.streamRevision !== undefined &&
      version.data.revision <= snapshot.streamRevision
    )
      continue;
    next = applyFrame(next, frame.event, frame.data);
  }
  return next;
}

const Delta = z.object({
  messageId: z.string(),
  text: z.string(),
  offset: z.number().int().nonnegative().optional(),
});
const Tool = z.object({
  messageId: z.string(),
  callId: z.string(),
  name: z.string(),
  phase: z.enum(["call", "result"]),
  isError: z.boolean().optional(),
  error: z.string().optional(),
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
  const error = frame.error === undefined ? {} : { error: frame.error };
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
        ...error,
      },
    ];
  }
  return list.map((t) =>
    t.callId === frame.callId
      ? { ...t, name: frame.name, status, isError, ...error }
      : t,
  );
}

function applyDelta(
  state: ThreadState,
  data: unknown,
  replace: boolean,
  thinking = false,
): ThreadState {
  const f = Delta.safeParse(data);
  if (!f.success) return state;
  const field = thinking ? "liveThinking" : "live";
  const saved = state.detail?.messages.find((m) => m.id === f.data.messageId);
  const previous = replace
    ? ""
    : (state[field][f.data.messageId] ??
      (thinking ? saved?.thinking : saved?.content) ??
      "");
  const offset = replace ? 0 : (f.data.offset ?? previous.length);
  // SSE replays can overlap a REST snapshot. Append only unseen characters.
  const unseen = Math.max(0, previous.length - offset);
  const text = previous + f.data.text.slice(unseen);
  return {
    ...state,
    [field]: { ...state[field], [f.data.messageId]: text },
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
      [messageId]: upsertTool(
        state.liveTools[messageId] ??
          state.detail?.messages.find((m) => m.id === messageId)?.tools ??
          [],
        f.data,
      ),
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

function applyKnownFrame(
  state: ThreadState,
  event: string,
  data: unknown,
): ThreadState {
  switch (event) {
    case "delta":
      return applyDelta(state, data, false);
    case "reset":
      return applyDelta(state, data, true);
    case "thinking":
      return applyDelta(state, data, false, true);
    case "thinking_reset":
      return applyDelta(state, data, true, true);
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

const VersionedFrame = z.object({
  messageId: z.string(),
  revision: z.number().int().nonnegative(),
});
const VERSIONED_EVENTS = new Set([
  "delta",
  "reset",
  "thinking",
  "thinking_reset",
  "tool",
]);

export function applyFrame(
  state: ThreadState,
  event: string,
  data: unknown,
): ThreadState {
  const frame = VERSIONED_EVENTS.has(event)
    ? VersionedFrame.safeParse(data)
    : null;
  if (frame?.success) {
    const previous = state.liveRevision[frame.data.messageId] ?? 0;
    if (frame.data.revision < previous) return state;
  }
  const next = applyKnownFrame(state, event, data);
  if (next === state) return state;
  return {
    ...next,
    liveRevision: frame?.success
      ? { ...next.liveRevision, [frame.data.messageId]: frame.data.revision }
      : next.liveRevision,
    bufferedFrames:
      state.bufferedFrames === null
        ? null
        : [...state.bufferedFrames, { event, data }],
  };
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

export function messageThinking(
  state: ThreadState,
  message: ChatMessageDto,
): string {
  return message.status === "streaming"
    ? (state.liveThinking[message.id] ?? message.thinking ?? "")
    : (message.thinking ?? "");
}

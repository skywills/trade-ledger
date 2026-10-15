import { randomUUID } from "node:crypto";
import type { Id } from "../../shared/domain.js";
import { AppError } from "../../shared/errors.js";
import type { RunUsage } from "../ai/runs.js";
import { type Store, write } from "../storage/database.js";

export type ThreadStatus =
  | "idle"
  | "running"
  | "waiting"
  | "limit_reached"
  | "failed";
export type MessageStatus = "complete" | "streaming" | "cancelled" | "failed";

export interface PendingInteraction {
  readonly kind: "approval" | "question";
  readonly requestId: string;
  readonly tool: string | null;
  readonly text: string;
  readonly expiresAt: string;
}
export interface Attachment {
  readonly previewId: string;
  readonly filename: string;
}
export interface ToolRecord {
  readonly callId: string;
  readonly name: string;
  readonly status: "running" | "done";
  readonly isError: boolean;
  readonly approval: "allowed" | "denied" | "expired" | "cancelled" | null;
}
export interface ChatThread {
  readonly id: Id;
  readonly title: string;
  readonly sessionId: string;
  readonly profileId: Id | null;
  readonly modelRef: string;
  readonly cloudConfirmed: boolean;
  readonly status: ThreadStatus;
  readonly pending: PendingInteraction | null;
  readonly seed: { issueKeys: string[] } | null;
  readonly usage: RunUsage;
  readonly cost: string;
  readonly nextSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface ChatMessage {
  readonly id: Id;
  readonly threadId: Id;
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachments: Attachment[];
  readonly tools: ToolRecord[];
  readonly status: MessageStatus;
  readonly error: string | null;
  readonly usage: RunUsage | null;
  readonly cost: string | null;
  readonly clientMessageId: string | null;
  readonly createdAt: string;
}
export interface NewThread {
  readonly title: string;
  readonly sessionId: string;
  readonly profileId: Id | null;
  readonly modelRef: string;
  readonly cloudConfirmed: boolean;
  readonly seed: { issueKeys: string[] } | null;
  readonly now: Date;
}
export interface ThreadPatch {
  readonly title?: string;
  readonly status?: ThreadStatus;
  readonly pending?: PendingInteraction | null;
  readonly usage?: RunUsage;
  readonly cost?: string;
  readonly now: Date;
}
export interface NewMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachments: Attachment[];
  readonly status: MessageStatus;
  readonly clientMessageId: string | null;
  readonly now: Date;
}
export interface MessagePatch {
  readonly content?: string;
  readonly tools?: ToolRecord[];
  readonly status?: MessageStatus;
  readonly error?: string | null;
  readonly usage?: RunUsage | null;
  readonly cost?: string | null;
}

const EMPTY_USAGE: RunUsage = {
  rounds: 0,
  inputTokens: 0,
  outputTokens: 0,
  generatedTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

interface ThreadRow {
  id: string;
  title: string;
  session_id: string;
  profile_id: string | null;
  model_ref: string;
  cloud_confirmed: number;
  status: string;
  pending_json: string | null;
  seed_json: string | null;
  usage_json: string;
  cost: string;
  next_seq: number;
  created_at: string;
  updated_at: string;
}
interface MessageRow {
  id: string;
  thread_id: string;
  seq: number;
  role: string;
  content: string;
  attachments_json: string | null;
  tools_json: string | null;
  status: string;
  error: string | null;
  usage_json: string | null;
  cost: string | null;
  client_message_id: string | null;
  created_at: string;
}

function parse<T>(text: string | null, fallback: T): T {
  return text === null ? fallback : (JSON.parse(text) as T);
}

function toThread(row: ThreadRow): ChatThread {
  return {
    id: row.id,
    title: row.title,
    sessionId: row.session_id,
    profileId: row.profile_id,
    modelRef: row.model_ref,
    cloudConfirmed: row.cloud_confirmed === 1,
    status: row.status as ThreadStatus,
    pending: parse(row.pending_json, null),
    seed: parse(row.seed_json, null),
    usage: parse(row.usage_json, EMPTY_USAGE),
    cost: row.cost,
    nextSeq: row.next_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    seq: row.seq,
    role: row.role as ChatMessage["role"],
    content: row.content,
    attachments: parse(row.attachments_json, []),
    tools: parse(row.tools_json, []),
    status: row.status as MessageStatus,
    error: row.error,
    usage: parse(row.usage_json, null),
    cost: row.cost,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at,
  };
}

function requireThread(store: Store, id: Id): ChatThread {
  const thread = readThread(store, id);
  if (thread === null)
    throw new AppError(
      "THREAD_NOT_FOUND",
      `No chat thread exists for id ${id}.`,
      404,
    );
  return thread;
}

export function readThread(store: Store, id: Id): ChatThread | null {
  const row = store.db
    .prepare("SELECT * FROM chat_threads WHERE id = ?")
    .get(id) as ThreadRow | undefined;
  return row === undefined ? null : toThread(row);
}

export function listThreads(store: Store): ChatThread[] {
  const rows = store.db
    .prepare(
      "SELECT * FROM chat_threads ORDER BY updated_at DESC, created_at DESC",
    )
    .all() as ThreadRow[];
  return rows.map(toThread);
}

export function createThread(
  store: Store,
  draft: NewThread,
): Promise<ChatThread> {
  const id = randomUUID();
  const at = draft.now.toISOString();
  return write(store, () => {
    store.db
      .prepare(
        `INSERT INTO chat_threads (id, title, session_id, profile_id, model_ref, cloud_confirmed, status,
         pending_json, seed_json, usage_json, cost, next_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'idle', NULL, ?, ?, '0', 0, ?, ?)`,
      )
      .run(
        id,
        draft.title,
        draft.sessionId,
        draft.profileId,
        draft.modelRef,
        draft.cloudConfirmed ? 1 : 0,
        draft.seed === null ? null : JSON.stringify(draft.seed),
        JSON.stringify(EMPTY_USAGE),
        at,
        at,
      );
    return requireThread(store, id);
  });
}

export function updateThread(
  store: Store,
  id: Id,
  patch: ThreadPatch,
): Promise<ChatThread> {
  return write(store, () => {
    const current = requireThread(store, id);
    const pending =
      patch.pending !== undefined ? patch.pending : current.pending;
    store.db
      .prepare(
        `UPDATE chat_threads SET title = ?, status = ?, pending_json = ?, usage_json = ?, cost = ?, updated_at = ?
       WHERE id = ?`,
      )
      .run(
        patch.title ?? current.title,
        patch.status ?? current.status,
        pending === null ? null : JSON.stringify(pending),
        JSON.stringify(patch.usage ?? current.usage),
        patch.cost ?? current.cost,
        patch.now.toISOString(),
        id,
      );
    return requireThread(store, id);
  });
}

export function deleteThread(store: Store, id: Id): Promise<void> {
  return write(store, () => {
    store.db.prepare("DELETE FROM chat_threads WHERE id = ?").run(id);
  });
}

export function appendMessage(
  store: Store,
  threadId: Id,
  draft: NewMessage,
): Promise<ChatMessage> {
  const id = randomUUID();
  return write(store, () =>
    store.db.transaction(() => {
      const thread = requireThread(store, threadId);
      store.db
        .prepare(
          `INSERT INTO chat_messages (id, thread_id, seq, role, content, attachments_json, tools_json, status,
           error, usage_json, cost, client_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          id,
          threadId,
          thread.nextSeq,
          draft.role,
          draft.content,
          JSON.stringify(draft.attachments),
          draft.status,
          draft.clientMessageId,
          draft.now.toISOString(),
        );
      store.db
        .prepare(
          "UPDATE chat_threads SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?",
        )
        .run(draft.now.toISOString(), threadId);
      return toMessage(
        store.db
          .prepare("SELECT * FROM chat_messages WHERE id = ?")
          .get(id) as MessageRow,
      );
    })(),
  );
}

export function findMessageByClientId(
  store: Store,
  threadId: Id,
  clientMessageId: string,
): ChatMessage | null {
  const row = store.db
    .prepare(
      "SELECT * FROM chat_messages WHERE thread_id = ? AND client_message_id = ?",
    )
    .get(threadId, clientMessageId) as MessageRow | undefined;
  return row === undefined ? null : toMessage(row);
}

export function listMessages(store: Store, threadId: Id): ChatMessage[] {
  const rows = store.db
    .prepare("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY seq")
    .all(threadId) as MessageRow[];
  return rows.map(toMessage);
}

export function updateMessage(
  store: Store,
  id: Id,
  patch: MessagePatch,
): Promise<ChatMessage> {
  return write(store, () => {
    const row = store.db
      .prepare("SELECT * FROM chat_messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
    if (row === undefined)
      throw new AppError(
        "MESSAGE_NOT_FOUND",
        `No chat message exists for id ${id}.`,
        404,
      );
    const current = toMessage(row);
    const usage = patch.usage !== undefined ? patch.usage : current.usage;
    store.db
      .prepare(
        `UPDATE chat_messages SET content = ?, tools_json = ?, status = ?, error = ?, usage_json = ?, cost = ? WHERE id = ?`,
      )
      .run(
        patch.content ?? current.content,
        JSON.stringify(patch.tools ?? current.tools),
        patch.status ?? current.status,
        patch.error !== undefined ? patch.error : current.error,
        usage === null ? null : JSON.stringify(usage),
        patch.cost !== undefined ? patch.cost : current.cost,
        id,
      );
    return toMessage(
      store.db
        .prepare("SELECT * FROM chat_messages WHERE id = ?")
        .get(id) as MessageRow,
    );
  });
}

/** Startup recovery: a dead process can leave turns mid-flight; fail them so the next send resumes. */
export function recoverChatThreads(store: Store, now: Date): Promise<void> {
  return write(store, () => {
    const at = now.toISOString();
    store.db
      .prepare(
        `UPDATE chat_threads SET status = 'failed', pending_json = NULL, updated_at = ?
       WHERE status IN ('running', 'waiting')`,
      )
      .run(at);
    store.db
      .prepare(
        "UPDATE chat_messages SET status = 'failed', error = 'INTERRUPTED' WHERE status = 'streaming'",
      )
      .run();
  });
}

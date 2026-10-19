import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import { pageSlice, parsePageParams, toEnvelope } from "../../shared/api.js";
import {
  AnswerBodySchema,
  CreateThreadBodySchema,
  PatchThreadBodySchema,
  SendMessageBodySchema,
} from "../../shared/chat-api.js";
import { AppError } from "../../shared/errors.js";
import { listRunsForThread } from "../ai/runs.js";
import type { ChatService } from "../chat/service.js";
import { listThreads, readThread, updateThread } from "../chat/threads.js";
import type { Store } from "../storage/database.js";

const KEEPALIVE_MS = 15_000;
const MAX_PENDING_STREAM_BYTES = 512 * 1024;

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new AppError(
      "INVALID_INPUT",
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
        .join("; "),
      400,
    );
  }
  return parsed.data;
}

function requireThread(store: Store, id: string) {
  const thread = readThread(store, id);
  if (thread === null)
    throw new AppError(
      "THREAD_NOT_FOUND",
      `No chat thread exists for id ${id}.`,
      404,
    );
  return thread;
}

function publicThread(thread: ReturnType<typeof requireThread>) {
  const { sessionId: _sessionId, nextSeq: _nextSeq, ...rest } = thread;
  return rest;
}

function idOf(request: { params: unknown }): string {
  return (request.params as { id: string }).id;
}

function registerThreadCrud(
  app: FastifyInstance,
  store: Store,
  chat: ChatService,
): void {
  app.get("/api/chat/threads", async (request) => {
    const params = parsePageParams(request.query);
    const all = listThreads(store).map(publicThread);
    return toEnvelope(pageSlice(all, params), params, all.length, null, false);
  });

  app.post("/api/chat/threads", async (request, reply) => {
    const body = parseBody(CreateThreadBodySchema, request.body);
    const thread = await chat.createThread({
      profileId: body.profileId ?? null,
      cloudConfirmed: body.cloudConfirmed ?? false,
      seed: body.seed ?? null,
    });
    reply.code(201);
    return { thread: publicThread(thread) };
  });

  app.get("/api/chat/threads/:id", async (request) => {
    const id = idOf(request);
    const thread = requireThread(store, id);
    return {
      thread: publicThread(thread),
      messages: chat.messages(id),
      runs: listRunsForThread(store, id),
    };
  });

  app.patch("/api/chat/threads/:id", async (request) => {
    const id = idOf(request);
    requireThread(store, id);
    const body = parseBody(PatchThreadBodySchema, request.body);
    const updated = await updateThread(store, id, {
      title: body.title,
      now: new Date(),
    });
    return { thread: publicThread(updated) };
  });

  app.delete("/api/chat/threads/:id", async (request, reply) => {
    await chat.deleteThread(idOf(request));
    reply.code(204);
    return null;
  });
}

function registerTurnControl(
  app: FastifyInstance,
  store: Store,
  chat: ChatService,
): void {
  app.post("/api/chat/threads/:id/messages", async (request, reply) => {
    const id = idOf(request);
    requireThread(store, id);
    const body = parseBody(SendMessageBodySchema, request.body);
    const result = await chat.sendMessage(id, {
      clientMessageId: body.clientMessageId,
      text: body.text,
      attachments: body.attachments ?? [],
    });
    reply.code(202);
    return result;
  });

  app.post("/api/chat/threads/:id/cancel", async (request, reply) => {
    const id = idOf(request);
    requireThread(store, id);
    chat.cancel(id);
    reply.code(202);
    return { status: "cancelling" };
  });

  app.post("/api/chat/threads/:id/answer", async (request) => {
    const id = idOf(request);
    requireThread(store, id);
    const body = parseBody(AnswerBodySchema, request.body);
    const answer =
      "decision" in body ? { decision: body.decision } : { text: body.text };
    return { status: chat.answer(id, body.requestId, answer) };
  });
}

type EndStream = () => void;

function registerEvents(
  app: FastifyInstance,
  store: Store,
  chat: ChatService,
): void {
  const open = new Set<EndStream>();
  // Hijacked SSE responses are never ended by Fastify; end them before close
  // waits on connections, or app.close() hangs while a browser has /chat open.
  app.addHook("preClose", async () => {
    for (const end of [...open]) end();
  });

  app.get("/api/chat/threads/:id/events", async (request, reply) => {
    const id = idOf(request);
    const thread = requireThread(store, id);
    const raw = reply.raw;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    let ended = false;
    let blocked = false;
    let pendingBytes = 0;
    let pendingHead = 0;
    let pending: { chunk: string; bytes: number }[] = [];
    const end: EndStream = () => {
      if (ended) return;
      ended = true;
      clearInterval(keepalive);
      pending.length = 0;
      pendingBytes = 0;
      unsubscribe();
      open.delete(end);
      if (!raw.writableEnded && !raw.destroyed) raw.end();
    };
    const send = (chunk: string) => {
      if (ended || raw.writableEnded || raw.destroyed) return;
      if (blocked) {
        const bytes = Buffer.byteLength(chunk);
        if (pendingBytes + bytes > MAX_PENDING_STREAM_BYTES) {
          // A peer that stopped reading cannot drain a graceful end. Close its
          // socket before releasing admission and shutdown tracking.
          raw.destroy();
          end();
          return;
        }
        pending.push({ chunk, bytes });
        pendingBytes += bytes;
      } else blocked = !raw.write(chunk);
    };
    raw.on("drain", () => {
      if (ended) return;
      blocked = false;
      while (pendingHead < pending.length && !blocked) {
        const item = pending[pendingHead];
        delete pending[pendingHead++];
        if (item === undefined) continue;
        pendingBytes -= item.bytes;
        blocked = !raw.write(item.chunk);
      }
      if (pendingHead === pending.length) {
        pending.length = 0;
        pendingHead = 0;
      } else if (pendingHead >= 1024 && pendingHead >= pending.length / 2) {
        // Amortize prefix compaction during a sustained, partially drained stream.
        pending = pending.slice(pendingHead);
        pendingHead = 0;
      }
    });
    const frame = (value: Parameters<typeof chat.bus.emit>[1]) =>
      send(`event: ${value.event}\ndata: ${JSON.stringify(value.data)}\n\n`);
    // Admission may throw 429 and must happen before SSE headers are sent.
    unsubscribe = chat.bus.subscribe(id, frame, {
      replay: false,
      onClose: end,
    });
    reply.hijack();
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    open.add(end);
    raw.on("close", end);
    raw.on("error", end);
    send(
      `event: ready\ndata: ${JSON.stringify({ threadStatus: thread.status })}\n\n`,
    );
    chat.bus.replayTo(id, frame);
    if (!ended)
      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
  });
}

/** Chat thread REST + SSE. Mutations sit behind the global origin guard. */
export async function registerChatRoutes(
  app: FastifyInstance,
  store: Store,
  chat: ChatService,
): Promise<void> {
  registerThreadCrud(app, store, chat);
  registerTurnControl(app, store, chat);
  registerEvents(app, store, chat);
}

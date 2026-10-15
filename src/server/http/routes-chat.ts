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
import {
  listMessages,
  listThreads,
  readThread,
  updateThread,
} from "../chat/threads.js";
import type { Store } from "../storage/database.js";

const KEEPALIVE_MS = 15_000;

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
      messages: listMessages(store, id),
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

function registerEvents(
  app: FastifyInstance,
  store: Store,
  chat: ChatService,
): void {
  app.get("/api/chat/threads/:id/events", async (request, reply) => {
    const id = idOf(request);
    const thread = requireThread(store, id);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const write = (event: string, data: unknown) =>
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write("ready", { threadStatus: thread.status });
    const unsubscribe = chat.bus.subscribe(id, (frame) =>
      write(frame.event, frame.data),
    );
    const keepalive = setInterval(
      () => reply.raw.write(": keepalive\n\n"),
      KEEPALIVE_MS,
    );
    request.raw.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
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

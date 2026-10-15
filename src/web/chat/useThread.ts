import { useCallback, useEffect, useState } from "react";
import {
  AnswerResponseSchema,
  type AttachmentDto,
  CancelResponseSchema,
  SendMessageResponseSchema,
  ThreadDetailSchema,
} from "../../shared/chat-api.js";
import { ApiError, request, requestJson } from "../api.js";
import { createReloader } from "./reloader.js";
import {
  applyFrame,
  initialThreadState,
  type ThreadState,
  withDetail,
} from "./threadController.js";

const REFETCH_EVENTS = new Set(["message", "thread", "proposal", "error"]);

const FRAME_EVENTS = [
  "delta",
  "reset",
  "tool",
  "approval",
  "question",
  "resolved",
  "proposal",
  "message",
  "thread",
  "error",
];

function loadFailure(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : "Failed to load the conversation.";
}

export function useThread(threadId: string) {
  const [state, setState] = useState<ThreadState>(initialThreadState);
  const [reloader] = useState(() =>
    createReloader({
      fetch: (id: string) =>
        request(`/api/chat/threads/${id}`, ThreadDetailSchema),
      apply: (_id, detail) => setState((s) => withDetail(s, detail)),
      fail: (_id, err) => setState((s) => ({ ...s, error: loadFailure(err) })),
    }),
  );

  const reload = useCallback(
    () => reloader.reload(threadId),
    [reloader, threadId],
  );

  useEffect(() => {
    reloader.activate(threadId);
    setState(initialThreadState());
    reloader.reload(threadId);
    if (typeof EventSource === "undefined") return () => reloader.deactivate();
    const source = new EventSource(`/api/chat/threads/${threadId}/events`);
    let opened = false;
    source.addEventListener("ready", () => {
      if (opened) reloader.reload(threadId); // a reconnect: REST is the source of truth
      opened = true;
    });
    for (const name of FRAME_EVENTS) {
      source.addEventListener(name, (event) => {
        let data: unknown = null;
        try {
          data = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        setState((s) => applyFrame(s, name, data));
        // Refetch frames call reload directly: the reloader coalesces calls
        // made during an in-flight load into exactly one rerun.
        if (REFETCH_EVENTS.has(name)) reloader.reload(threadId);
      });
    }
    return () => {
      source.close();
      reloader.deactivate();
    };
  }, [threadId, reloader]);

  const send = useCallback(
    async (text: string, attachments: AttachmentDto[]) => {
      const clientMessageId = crypto.randomUUID();
      await requestJson(
        `/api/chat/threads/${threadId}/messages`,
        SendMessageResponseSchema,
        "POST",
        { clientMessageId, text, attachments },
      );
      reload();
    },
    [threadId, reload],
  );

  const cancel = useCallback(async () => {
    await requestJson(
      `/api/chat/threads/${threadId}/cancel`,
      CancelResponseSchema,
      "POST",
    );
  }, [threadId]);

  const answer = useCallback(
    async (
      requestId: string,
      reply: { decision: "allow" | "deny" } | { text: string },
    ) => {
      return requestJson(
        `/api/chat/threads/${threadId}/answer`,
        AnswerResponseSchema,
        "POST",
        { requestId, ...reply },
      );
    },
    [threadId],
  );

  return { state, send, cancel, answer, reload };
}

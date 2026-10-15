import { useCallback, useEffect, useRef, useState } from "react";
import {
  AnswerResponseSchema,
  type AttachmentDto,
  CancelResponseSchema,
  SendMessageResponseSchema,
  ThreadDetailSchema,
} from "../../shared/chat-api.js";
import { ApiError, request, requestJson } from "../api.js";
import {
  applyFrame,
  initialThreadState,
  type ThreadState,
  withDetail,
} from "./threadController.js";

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

export function useThread(threadId: string) {
  const [state, setState] = useState<ThreadState>(initialThreadState);
  const loading = useRef(false);

  const reload = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const detail = await request(
        `/api/chat/threads/${threadId}`,
        ThreadDetailSchema,
      );
      setState((s) => withDetail(s, detail));
    } catch (err) {
      setState((s) => ({
        ...s,
        error:
          err instanceof ApiError
            ? err.message
            : "Failed to load the conversation.",
      }));
    } finally {
      loading.current = false;
    }
  }, [threadId]);

  useEffect(() => {
    setState(initialThreadState());
    void reload();
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/chat/threads/${threadId}/events`);
    let opened = false;
    source.addEventListener("ready", () => {
      if (opened) void reload(); // a reconnect: REST is the source of truth
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
      });
    }
    return () => source.close();
  }, [threadId, reload]);

  useEffect(() => {
    if (state.needsRefetch) void reload();
  }, [state.needsRefetch, reload]);

  const send = useCallback(
    async (text: string, attachments: AttachmentDto[]) => {
      const clientMessageId = crypto.randomUUID();
      await requestJson(
        `/api/chat/threads/${threadId}/messages`,
        SendMessageResponseSchema,
        "POST",
        { clientMessageId, text, attachments },
      );
      await reload();
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

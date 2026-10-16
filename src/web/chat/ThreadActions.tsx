import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
  type ChatThreadDto,
  ThreadEnvelopeSchema,
} from "../../shared/chat-api.js";
import { requestJson } from "../api.js";
import { ErrorPanel } from "../components.js";
import { navigate } from "../navigation.js";

export function ThreadActions({
  thread,
  onChanged,
}: {
  thread: ChatThreadDto;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "delete">("idle");
  const [title, setTitle] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<"rename" | "delete" | null>(null);
  const running = thread.status === "running" || thread.status === "waiting";
  useEffect(() => {
    if (mode === "rename") input.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== "idle" || busy || running || restoreFocus.current === null)
      return;
    (restoreFocus.current === "rename"
      ? renameButton
      : deleteButton
    ).current?.focus();
    restoreFocus.current = null;
  }, [mode, busy, running]);

  function cancel() {
    restoreFocus.current = mode === "rename" ? "rename" : "delete";
    setMode("idle");
    setError(null);
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await requestJson(
        `/api/chat/threads/${thread.id}`,
        ThreadEnvelopeSchema,
        "PATCH",
        { title: title.trim() },
      );
      restoreFocus.current = "rename";
      setMode("idle");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await requestJson(`/api/chat/threads/${thread.id}`, z.null(), "DELETE");
      navigate("/chat");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="thread-actions">
      <div className="action-row">
        <button
          ref={renameButton}
          type="button"
          disabled={busy || running}
          onClick={() => {
            setTitle(thread.title);
            setError(null);
            setMode("rename");
          }}
        >
          Rename conversation
        </button>
        <button
          ref={deleteButton}
          type="button"
          className="danger"
          disabled={busy || running}
          onClick={() => {
            setError(null);
            setMode("delete");
          }}
        >
          Delete conversation
        </button>
      </div>
      {running ? (
        <p className="muted">Stop the reply before renaming or deleting.</p>
      ) : null}
      {mode === "rename" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) cancel();
          }}
        >
          <label>
            Conversation title{" "}
            <input
              ref={input}
              value={title}
              maxLength={120}
              required
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <div className="action-row">
            <button type="submit" disabled={busy || title.trim() === ""}>
              Save title
            </button>
            <button type="button" disabled={busy} onClick={cancel}>
              Cancel rename
            </button>
          </div>
        </form>
      ) : null}
      {mode === "delete" ? (
        <div>
          <p role="alert">
            Delete “{thread.title}”? Messages and chat transcripts will be
            removed. Journal decisions are retained.
          </p>
          <div className="action-row">
            <button
              type="button"
              className="danger"
              disabled={busy || running}
              onClick={() => void remove()}
            >
              Confirm delete
            </button>
            <button type="button" disabled={busy} onClick={cancel}>
              Keep conversation
            </button>
          </div>
        </div>
      ) : null}
      {error !== null ? <ErrorPanel message={error} /> : null}
    </div>
  );
}

import { useState } from "react";
import {
  ThreadEnvelopeSchema,
  ThreadsEnvelope,
} from "../../shared/chat-api.js";
import { ApiError, requestJson, useJson } from "../api.js";
import { ErrorPanel } from "../components.js";
import { Link, navigate } from "../navigation.js";
import { ThreadView } from "./ThreadView.js";

const PROFILE_CODES = new Set([
  "NO_PROFILE",
  "PROFILE_DISABLED",
  "PROFILE_NOT_VERIFIED",
]);

export function ChatPage({ threadId }: { threadId: string | undefined }) {
  const threads = useJson("/api/chat/threads?pageSize=100", ThreadsEnvelope);
  const [error, setError] = useState<{
    message: string;
    code: string | null;
  } | null>(null);
  const [cloudConfirmed, setCloudConfirmed] = useState(false);

  async function newThread() {
    setError(null);
    try {
      const { thread } = await requestJson(
        "/api/chat/threads",
        ThreadEnvelopeSchema,
        "POST",
        { cloudConfirmed },
      );
      threads.reload();
      navigate(`/chat/${thread.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { message: err.message, code: err.code }
          : { message: "Could not start a conversation.", code: null },
      );
    }
  }

  return (
    <section className="chat-page" data-testid="chat-page">
      <aside className="thread-list" data-testid="thread-list">
        <button
          type="button"
          data-testid="new-thread"
          onClick={() => void newThread()}
        >
          New conversation
        </button>
        <label className="muted">
          <input
            type="checkbox"
            checked={cloudConfirmed}
            onChange={(e) => setCloudConfirmed(e.target.checked)}
          />{" "}
          Allow sending journal data to a cloud model
        </label>
        {error !== null ? <ErrorPanel message={error.message} /> : null}
        <ul>
          {(threads.data?.items ?? []).map((t) => (
            <li key={t.id}>
              <Link
                to={`/chat/${t.id}`}
                aria-current={t.id === threadId ? "page" : undefined}
              >
                {t.title}
              </Link>
            </li>
          ))}
        </ul>
        {error?.code != null && PROFILE_CODES.has(error.code) ? (
          <p>
            <Link to="/maintenance">
              Configure a model in Maintenance → Models
            </Link>
          </p>
        ) : null}
      </aside>
      {threadId === undefined ? (
        <p className="muted">
          Start a conversation to ask about your journal, P&amp;L or imports.
        </p>
      ) : (
        <ThreadView threadId={threadId} />
      )}
    </section>
  );
}

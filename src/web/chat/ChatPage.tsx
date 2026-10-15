import { useState } from "react";
import type { ChatThreadDto } from "../../shared/chat-api.js";
import { ThreadsEnvelope } from "../../shared/chat-api.js";
import { useJson } from "../api.js";
import { Link } from "../navigation.js";
import { AgentHome } from "./AgentHome.js";
import { ListIcon, PlusIcon } from "./icons.js";
import { ThreadView } from "./ThreadView.js";

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "5 minutes ago" style label for the conversation list. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds)) return "";
  const abs = Math.abs(seconds);
  if (abs < 60) return "just now";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  return RELATIVE.format(Math.round(seconds / 86_400), "day");
}

function ThreadLinks({
  items,
  threadId,
}: {
  items: ChatThreadDto[];
  threadId: string | undefined;
}) {
  if (items.length === 0) {
    return <p className="muted thread-empty">No conversations yet.</p>;
  }
  return (
    <ul>
      {items.map((t) => (
        <li key={t.id}>
          <Link
            to={`/chat/${t.id}`}
            aria-current={t.id === threadId ? "page" : undefined}
          >
            <span className="thread-title">{t.title}</span>
            <span className="thread-meta">
              {t.status === "running" || t.status === "waiting"
                ? "Replying… · "
                : ""}
              {relativeTime(t.updatedAt)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const NARROW = "(max-width: 768px)";

function Sidebar({
  items,
  threadId,
}: {
  items: ChatThreadDto[];
  threadId: string | undefined;
}) {
  // Phones start with the list folded so the conversation comes first.
  const [open] = useState(
    () => typeof window === "undefined" || !window.matchMedia?.(NARROW).matches,
  );
  return (
    <aside
      className="thread-list"
      data-testid="thread-list"
      aria-label="Conversations"
    >
      <Link to="/chat" className="new-thread" data-testid="new-thread">
        <PlusIcon />
        New conversation
      </Link>
      <details className="thread-drawer" open={open}>
        <summary>
          <ListIcon />
          Conversations <span className="muted">({items.length})</span>
        </summary>
        <ThreadLinks items={items} threadId={threadId} />
      </details>
    </aside>
  );
}

/** Agent-first landing: the home composer, or one conversation, beside the list. */
export function ChatPage({ threadId }: { threadId: string | undefined }) {
  const threads = useJson("/api/chat/threads?pageSize=100", ThreadsEnvelope);
  const items = threads.data?.items ?? [];
  return (
    <section className="chat-page" data-testid="chat-page">
      <Sidebar items={items} threadId={threadId} />
      <div className="chat-main">
        {threadId === undefined ? (
          <AgentHome onStarted={threads.reload} />
        ) : (
          <ThreadView
            key={threadId}
            threadId={threadId}
            onThreadChanged={threads.reload}
          />
        )}
      </div>
    </section>
  );
}

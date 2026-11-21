import { useEffect, useRef, useState } from "react";
import type { PendingDto, ThreadDetailDto } from "../../shared/chat-api.js";
import { ApiError } from "../api.js";
import { ErrorPanel, Loading } from "../components.js";
import { useQuery } from "../navigation.js";
import { ProposalList } from "../review/ProposalList.js";
import { Composer } from "./Composer.js";
import { InteractionCard } from "./InteractionCard.js";
import { MessageItem } from "./MessageItem.js";
import { ThreadActions } from "./ThreadActions.js";
import {
  messageText,
  messageThinking,
  messageTools,
  type ThreadState,
} from "./threadController.js";
import { useThread } from "./useThread.js";

function ThreadHeader({
  thread,
  onChanged,
}: {
  thread: ThreadDetailDto["thread"];
  onChanged: () => void;
}) {
  const tokens = thread.usage.generatedTokens;
  const coverage =
    thread.usage.costCoverage ??
    (Number(thread.cost) > 0 ? "partial" : "unpriced");
  const cost =
    coverage === "priced"
      ? `$${thread.cost}`
      : coverage === "partial"
        ? `Known cost $${thread.cost} (partially priced)`
        : "Cost unavailable";
  return (
    <header className="thread-header">
      <div className="thread-heading">
        <h2>{thread.title}</h2>
        <p className="muted">
          {thread.modelRef} · {cost}
          {tokens > 0 ? ` · ${tokens.toLocaleString("en-US")} tokens` : ""}
        </p>
      </div>
      <ThreadActions thread={thread} onChanged={onChanged} />
    </header>
  );
}

/** Announces turn progress once, instead of every streamed delta. */
function TurnAnnouncer({
  running,
  pending,
  expiredRequestId,
}: {
  running: boolean;
  pending: PendingDto | null;
  expiredRequestId: string | null;
}) {
  const [said, setSaid] = useState("");
  const wasRunning = useRef(running);
  const lastExpired = useRef<string | null>(null);
  const lastAnnounced = useRef<string | null>(null);
  const { requestId, kind, text, tool, expiresAt } = pending ?? {};
  useEffect(() => {
    const previouslyRunning = wasRunning.current;
    wasRunning.current = running;
    if (requestId && expiresAt) {
      const remaining = Math.max(0, Date.parse(expiresAt) - Date.now());
      const expire = () => {
        lastExpired.current = requestId;
        setSaid("Request expired.");
      };
      if (remaining <= 0) {
        expire();
        return;
      }
      if (lastAnnounced.current !== requestId) {
        lastAnnounced.current = requestId;
        setSaid(
          `${kind === "approval" ? "Approval needed" : "Answer needed"}. ${tool ?? ""} ${text} Expires in ${Math.ceil(remaining / 1000)} seconds.`,
        );
      }
      const timer = setTimeout(expire, remaining);
      return () => clearTimeout(timer);
    }
    if (expiredRequestId && expiredRequestId !== lastExpired.current) {
      lastExpired.current = expiredRequestId;
      setSaid("Request expired.");
    } else if (running && (!previouslyRunning || !expiredRequestId))
      setSaid("The agent is replying.");
    else if (previouslyRunning && !running)
      setSaid("The agent finished replying.");
  }, [running, requestId, expiresAt, kind, text, tool, expiredRequestId]);
  return (
    <p className="sr-only" role="status">
      {said}
    </p>
  );
}

function MessageList({
  state,
  detail,
}: {
  state: ThreadState;
  detail: ThreadDetailDto;
}) {
  return (
    <div className="message-list">
      {detail.messages.map((m) => (
        <MessageItem
          key={m.id}
          message={m}
          text={messageText(state, m)}
          thinking={messageThinking(state, m)}
          tools={messageTools(state, m)}
        />
      ))}
    </div>
  );
}

function useStop(cancel: () => Promise<unknown>) {
  const [stopError, setStopError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    cancel()
      .catch((err: unknown) =>
        setStopError(
          err instanceof ApiError ? err.message : "Could not stop the turn.",
        ),
      )
      .finally(() => setStopping(false));
  };
  return { stop, stopError, stopping };
}

function Notices({
  stopError,
  error,
  limited,
}: {
  stopError: string | null;
  error: string | null;
  limited: boolean;
}) {
  return (
    <>
      {stopError !== null ? (
        <p className="error-text" role="alert">
          {stopError}
        </p>
      ) : null}
      {error !== null ? <ErrorPanel message={error} /> : null}
      {limited ? (
        <p className="error-text" role="alert">
          This conversation reached its usage limit. Start a new conversation to
          continue.
        </p>
      ) : null}
    </>
  );
}

export function ThreadView({
  threadId,
  onThreadChanged,
}: {
  threadId: string;
  onThreadChanged: () => void;
}) {
  const { state, send, cancel, answer, reload } = useThread(threadId);
  const query = useQuery();
  const { stop, stopError, stopping } = useStop(cancel);
  const title = state.detail?.thread.title;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the title is the trigger
  useEffect(() => {
    if (title !== undefined) onThreadChanged();
  }, [title]);
  if (state.detail === null) {
    return state.error !== null ? (
      <ErrorPanel message={state.error} />
    ) : (
      <Loading label="Loading conversation" />
    );
  }
  const { thread, runs } = state.detail;
  const running = thread.status === "running" || thread.status === "waiting";
  const limited = thread.status === "limit_reached";
  const pending = state.pending;
  return (
    <section className="thread-view">
      <ThreadHeader
        thread={thread}
        onChanged={() => {
          void reload();
          onThreadChanged();
        }}
      />
      <TurnAnnouncer
        running={running}
        pending={pending}
        expiredRequestId={state.expiredRequestId}
      />
      <MessageList state={state} detail={state.detail} />
      {runs
        .filter((r) => r.proposals.length > 0)
        .map((run) => (
          <ProposalList
            key={run.id}
            run={run}
            onChanged={() => void reload()}
          />
        ))}
      {pending !== null ? (
        <InteractionCard
          key={pending.requestId}
          pending={pending}
          onAnswer={(reply) => answer(pending.requestId, reply)}
        />
      ) : null}
      <Notices stopError={stopError} error={state.error} limited={limited} />
      <div className="composer-dock">
        <Composer
          key={threadId}
          disabled={running || limited}
          initialText={query.get("prefill") ?? ""}
          placeholder={
            pending
              ? "The agent is waiting for your answer…"
              : running
                ? "The agent is replying…"
                : "Ask a follow-up…"
          }
          onSend={send}
          onStop={running ? stop : undefined}
          footer={
            pending && (
              <button
                type="button"
                onClick={() =>
                  document.getElementById("pending-request")?.focus()
                }
              >
                Go to pending request
              </button>
            )
          }
          stopping={stopping}
        />
      </div>
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import type { ThreadDetailDto } from "../../shared/chat-api.js";
import { ApiError } from "../api.js";
import { ErrorPanel, Loading } from "../components.js";
import { useQuery } from "../navigation.js";
import { ProposalList } from "../review/ProposalList.js";
import { Composer } from "./Composer.js";
import { InteractionCard } from "./InteractionCard.js";
import { StopIcon } from "./icons.js";
import { MessageItem } from "./MessageItem.js";
import {
  messageText,
  messageTools,
  type ThreadState,
} from "./threadController.js";
import { useThread } from "./useThread.js";

function ThreadHeader({
  thread,
  running,
  onStop,
}: {
  thread: ThreadDetailDto["thread"];
  running: boolean;
  onStop: () => void;
}) {
  const tokens = thread.usage.generatedTokens;
  return (
    <header className="thread-header">
      <div className="thread-heading">
        <h2>{thread.title}</h2>
        <p className="muted">
          {thread.modelRef} · ${thread.cost}
          {tokens > 0 ? ` · ${tokens.toLocaleString("en-US")} tokens` : ""}
        </p>
      </div>
      {running ? (
        <button
          type="button"
          className="secondary stop-button"
          data-testid="stop-turn"
          onClick={onStop}
        >
          <StopIcon />
          Stop
        </button>
      ) : null}
    </header>
  );
}

/** Announces turn progress once, instead of every streamed delta. */
function TurnAnnouncer({ running }: { running: boolean }) {
  const [said, setSaid] = useState("");
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running) setSaid("The agent is replying.");
    else if (wasRunning.current) setSaid("The agent replied.");
    wasRunning.current = running;
  }, [running]);
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
          tools={messageTools(state, m)}
        />
      ))}
    </div>
  );
}

function useStop(cancel: () => Promise<unknown>) {
  const [stopError, setStopError] = useState<string | null>(null);
  const stop = () => {
    setStopError(null);
    cancel().catch((err: unknown) =>
      setStopError(
        err instanceof ApiError ? err.message : "Could not stop the turn.",
      ),
    );
  };
  return { stop, stopError };
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
  const { stop, stopError } = useStop(cancel);
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
      <ThreadHeader thread={thread} running={running} onStop={stop} />
      <TurnAnnouncer running={running} />
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
          placeholder={running ? "The agent is replying…" : "Ask a follow-up…"}
          onSend={send}
        />
      </div>
    </section>
  );
}

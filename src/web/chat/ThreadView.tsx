import type { ThreadDetailDto } from "../../shared/chat-api.js";
import { ErrorPanel, Loading } from "../components.js";
import { useQuery } from "../navigation.js";
import { ProposalList } from "../review/ProposalList.js";
import { Composer } from "./Composer.js";
import { InteractionCard } from "./InteractionCard.js";
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
      <h2>{thread.title}</h2>
      <p className="muted">
        {thread.modelRef} · ${thread.cost}
        {tokens > 0 ? ` · ${tokens} tokens` : ""}
      </p>
      {running ? (
        <button
          type="button"
          className="secondary"
          data-testid="stop-turn"
          onClick={onStop}
        >
          Stop
        </button>
      ) : null}
    </header>
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
    <div className="message-list" aria-live="polite">
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

export function ThreadView({ threadId }: { threadId: string }) {
  const { state, send, cancel, answer, reload } = useThread(threadId);
  const query = useQuery();
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
        running={running}
        onStop={() => void cancel()}
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
          pending={pending}
          onAnswer={(reply) => answer(pending.requestId, reply)}
        />
      ) : null}
      {state.error !== null ? <ErrorPanel message={state.error} /> : null}
      {limited ? (
        <p className="error-text">
          This thread reached its usage limit. Start a new thread to continue.
        </p>
      ) : null}
      <Composer
        key={threadId}
        disabled={running || limited}
        initialText={query.get("prefill") ?? ""}
        onSend={send}
      />
    </section>
  );
}

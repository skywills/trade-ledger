import { useEffect, useRef, useState } from "react";
import type { PendingDto } from "../../shared/chat-api.js";
import { ApiError } from "../api.js";
import { ShieldIcon } from "./icons.js";

type Reply = { decision: "allow" | "deny" } | { text: string };

function secondsLeft(expiresAt: string): number | null {
  const at = Date.parse(expiresAt);
  return Number.isNaN(at)
    ? null
    : Math.max(0, Math.round((at - Date.now()) / 1000));
}

/** Remaining time before nax-agent auto-denies; null when the timestamp is unusable. */
function useCountdown(expiresAt: string): number | null {
  const [left, setLeft] = useState(() => secondsLeft(expiresAt));
  useEffect(() => {
    const timer = setInterval(() => setLeft(secondsLeft(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return left;
}

function formatLeft(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function useAnswer(onAnswer: (reply: Reply) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (reply: Reply) => {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(reply);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not send your answer.",
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Expiry({ expiresAt }: { expiresAt: string }) {
  const left = useCountdown(expiresAt);
  if (left === null) return null;
  return (
    <p className="interaction-expiry">
      {left > 0
        ? `Expires in ${formatLeft(left)} (then it is denied)`
        : "Expired"}
    </p>
  );
}

export function InteractionCard({
  pending,
  onAnswer,
}: {
  pending: PendingDto;
  onAnswer: (reply: Reply) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const { busy, error, run } = useAnswer(onAnswer);
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus(), []);
  const approval = pending.kind === "approval";
  return (
    <section
      ref={card}
      tabIndex={-1}
      className="interaction-card"
      data-testid={approval ? "approval-card" : "question-card"}
      aria-labelledby="interaction-title"
    >
      <p id="interaction-title" className="interaction-title">
        <ShieldIcon />
        {approval ? "Approval needed" : "The agent has a question"}
        {approval && pending.tool !== null ? (
          <code className="interaction-tool">{pending.tool}</code>
        ) : null}
      </p>
      <p className="interaction-text">{pending.text}</p>
      <Expiry expiresAt={pending.expiresAt} />
      {error !== null ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {approval ? (
        <div className="actions">
          <button
            type="button"
            className="primary"
            data-testid="approval-allow"
            disabled={busy}
            onClick={() => void run({ decision: "allow" })}
          >
            Allow
          </button>
          <button
            type="button"
            className="secondary"
            data-testid="approval-deny"
            disabled={busy}
            onClick={() => void run({ decision: "deny" })}
          >
            Deny
          </button>
        </div>
      ) : (
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== "") void run({ text });
          }}
        >
          <input
            aria-label="Your answer"
            value={text}
            maxLength={4096}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" disabled={busy || text.trim() === ""}>
            Answer
          </button>
        </form>
      )}
    </section>
  );
}

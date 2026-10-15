import { useState } from "react";
import type { PendingDto } from "../../shared/chat-api.js";

type Reply = { decision: "allow" | "deny" } | { text: string };

export function InteractionCard({
  pending,
  onAnswer,
}: {
  pending: PendingDto;
  onAnswer: (reply: Reply) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (reply: Reply) => {
    setBusy(true);
    try {
      await onAnswer(reply);
    } finally {
      setBusy(false);
    }
  };
  if (pending.kind === "approval") {
    return (
      <div
        className="interaction-card"
        data-testid="approval-card"
        role="alertdialog"
        aria-label="Approval needed"
      >
        <p>
          <strong>The agent wants to:</strong> {pending.text}
        </p>
        <div className="actions">
          <button
            type="button"
            data-testid="approval-allow"
            disabled={busy}
            onClick={() => void run({ decision: "allow" })}
          >
            Allow
          </button>
          <button
            type="button"
            data-testid="approval-deny"
            className="secondary"
            disabled={busy}
            onClick={() => void run({ decision: "deny" })}
          >
            Deny
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="interaction-card" data-testid="question-card">
      <p>{pending.text}</p>
      <input
        aria-label="Answer"
        value={text}
        maxLength={4096}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        type="button"
        disabled={busy || text.trim() === ""}
        onClick={() => void run({ text })}
      >
        Answer
      </button>
    </div>
  );
}

import { useState } from "react";
import {
  AcceptAnalysisResponseSchema,
  type AnalysisRunDto,
  RejectAnalysisResponseSchema,
} from "../../shared/api.js";
import { ApiError, requestJson } from "../api.js";
import { ErrorPanel } from "../components.js";

async function recordDecision(run: AnalysisRunDto, proposalId: string | null) {
  // Evidence is immutable; let the server use the current decision watermark.
  if (proposalId !== null) {
    await requestJson(
      `/api/analysis/${run.id}/accept`,
      AcceptAnalysisResponseSchema,
      "POST",
      { proposalId },
    );
    return;
  }
  await requestJson(
    `/api/analysis/${run.id}/reject`,
    RejectAnalysisResponseSchema,
    "POST",
    { reason: "Rejected in chat" },
  );
}

/** Accept/reject cards for one proposal run. Acceptance is what appends a decision. */
export function ProposalList({
  run,
  onChanged,
}: {
  run: AnalysisRunDto;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = run.proposals.filter((p) => !p.accepted).length;

  async function decide(proposalId: string | null) {
    setBusy(true);
    setError(null);
    try {
      await recordDecision(run, proposalId);
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Failed to record the decision.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="proposal-list" data-testid="proposal-list">
      {error !== null ? <ErrorPanel message={error} /> : null}
      <ul>
        {run.proposals.map((entry) => (
          <li key={entry.id} className="proposal-card">
            <div>
              <strong>{entry.proposal.kind}</strong>{" "}
              <span className="muted">
                ({entry.accepted ? "accepted" : "pending"})
              </span>
              {entry.proposal.rationale ? (
                <p>{entry.proposal.rationale}</p>
              ) : null}
            </div>
            {entry.accepted ? null : (
              <button
                type="button"
                onClick={() => void decide(entry.id)}
                disabled={busy}
              >
                Accept
              </button>
            )}
          </li>
        ))}
      </ul>
      {pending > 0 ? (
        <button
          type="button"
          className="secondary"
          onClick={() => void decide(null)}
          disabled={busy}
        >
          Reject all pending
        </button>
      ) : null}
    </div>
  );
}

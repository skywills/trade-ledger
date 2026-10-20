import { useState } from "react";
import {
  AcceptAnalysisResponseSchema,
  type AnalysisRunDto,
  RejectAnalysisResponseSchema,
} from "../../shared/api.js";
import { ApiError, requestJson } from "../api.js";
import { ErrorPanel } from "../components.js";
import { BuildAction } from "../lifecycles/BuildAction.js";
import { AgentConnectionProposal } from "./AgentConnectionProposal.js";
import { proposalSummary } from "./proposalSummary.js";

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
  const [needsUpdate, setNeedsUpdate] = useState(false);
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
      {needsUpdate && (
        <section
          className="connection-status"
          aria-label="Journal update needed"
        >
          <p role="status">
            A connection decision may already be saved. Update the journal
            before continuing.
          </p>
          <BuildAction
            onBuilt={() => {
              setNeedsUpdate(false);
              onChanged();
            }}
          />
        </section>
      )}
      <ul>
        {run.proposals.map((entry) => (
          <li key={entry.id} className="proposal-card">
            <AgentConnectionProposal
              run={run}
              entry={entry}
              onChanged={onChanged}
              onRecoveryNeeded={() => setNeedsUpdate(true)}
            >
              <div>
                <strong>{entry.proposal.kind}</strong>{" "}
                <span className="muted">
                  ({entry.accepted ? "accepted" : "pending"})
                </span>
                {entry.proposal.rationale ? (
                  <p>{entry.proposal.rationale}</p>
                ) : null}
                <ul
                  aria-label="Proposed changes"
                  style={{ overflowWrap: "anywhere" }}
                >
                  {proposalSummary(entry.proposal).map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: immutable proposal lines
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </div>
              {entry.accepted ? null : (
                <button
                  type="button"
                  onClick={() => void decide(entry.id)}
                  disabled={busy || needsUpdate}
                >
                  Accept
                </button>
              )}
            </AgentConnectionProposal>
          </li>
        ))}
      </ul>
      {pending > 0 ? (
        <button
          type="button"
          className="secondary"
          onClick={() => void decide(null)}
          disabled={busy || needsUpdate}
        >
          Reject all pending
        </button>
      ) : null}
    </div>
  );
}

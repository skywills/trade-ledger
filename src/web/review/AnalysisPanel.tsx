import { useCallback, useEffect, useRef, useState } from "react";
import {
  AcceptAnalysisResponseSchema,
  AnalysisEnvelopeSchema,
  type AnalysisRunDto,
  AnswerAnalysisResponseSchema,
  RejectAnalysisResponseSchema,
  StartAnalysisResponseSchema,
} from "../../shared/api.js";
import { ApiError, request, requestJson } from "../api.js";
import { ErrorPanel } from "../components.js";

const TERMINAL = new Set(["proposal_ready", "failed", "cancelled", "accepted"]);

interface Question {
  requestId: string;
  text: string;
}

/**
 * Local analysis panel. Starts a bounded run against the active build, polls it
 * to a terminal state, and lets a person accept or reject each recorded
 * proposal. Acceptance is what appends a decision; the model never does.
 */
export function AnalysisPanel() {
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<AnalysisRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async (id: string) => {
    try {
      const payload = await request(
        `/api/analysis/${id}`,
        AnalysisEnvelopeSchema,
      );
      setRun(payload.run);
      if (TERMINAL.has(payload.run.status) && timer.current !== null) {
        clearInterval(timer.current);
        timer.current = null;
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to load the run.",
      );
    }
  }, []);

  useEffect(() => {
    if (runId === null) return;
    void poll(runId);
    timer.current = setInterval(() => void poll(runId), 500);
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
      timer.current = null;
    };
  }, [runId, poll]);

  useEffect(() => {
    if (runId === null || typeof EventSource === "undefined") return;
    const source = new EventSource(`/api/analysis/${runId}/events`);
    source.addEventListener("question", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as Question;
      setQuestion({ requestId: payload.requestId, text: payload.text });
    });
    return () => source.close();
  }, [runId]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await requestJson(
        "/api/analysis",
        StartAnalysisResponseSchema,
        "POST",
        { cloudConfirmed: false },
      );
      setRunId(payload.runId);
      setQuestion(null);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to start analysis.",
      );
    } finally {
      setBusy(false);
    }
  }, []);

  const decide = useCallback(
    async (proposalId: string, accept: boolean) => {
      if (runId === null || run === null) return;
      const expectedWatermark = run.evidence.watermark;
      setBusy(true);
      try {
        if (accept) {
          await requestJson(
            `/api/analysis/${runId}/accept`,
            AcceptAnalysisResponseSchema,
            "POST",
            { proposalId, expectedWatermark },
          );
        } else {
          await requestJson(
            `/api/analysis/${runId}/reject`,
            RejectAnalysisResponseSchema,
            "POST",
            { reason: "Rejected in review", expectedWatermark },
          );
        }
        await poll(runId);
      } catch (err) {
        setError(
          err instanceof ApiError ? err.message : "Failed to record decision.",
        );
      } finally {
        setBusy(false);
      }
    },
    [runId, run, poll],
  );

  const submitAnswer = useCallback(async () => {
    if (runId === null || question === null) return;
    setBusy(true);
    try {
      await requestJson(
        `/api/analysis/${runId}/answer`,
        AnswerAnalysisResponseSchema,
        "POST",
        { requestId: question.requestId, text: answer },
      );
      setQuestion(null);
      setAnswer("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to answer.");
    } finally {
      setBusy(false);
    }
  }, [runId, question, answer]);

  return (
    <section data-testid="analysis-panel">
      <h3>AI reconciliation</h3>
      <button type="button" onClick={() => void start()} disabled={busy}>
        Start analysis
      </button>
      {error !== null ? <ErrorPanel message={error} /> : null}
      {run === null ? (
        <p className="muted">No analysis run yet.</p>
      ) : (
        <>
          <p data-testid="analysis-status">
            Status: {run.status}
            {run.usage === null
              ? ""
              : ` · ${run.usage.outputTokens} output tokens`}
            {run.costSource === null ? "" : ` · cost: ${run.costSource}`}
          </p>
          {question !== null ? (
            <div data-testid="analysis-question">
              <p>{question.text}</p>
              <input
                aria-label="Answer"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <button
                type="button"
                onClick={() => void submitAnswer()}
                disabled={busy}
              >
                Answer
              </button>
            </div>
          ) : null}
          <ul data-testid="analysis-proposals">
            {run.proposals.map((entry) => (
              <li key={entry.id}>
                <span>
                  {entry.proposal.kind} (
                  {entry.accepted ? "accepted" : "pending"})
                </span>
                {entry.accepted ? null : (
                  <>
                    <button
                      type="button"
                      onClick={() => void decide(entry.id, true)}
                      disabled={busy}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => void decide(entry.id, false)}
                      disabled={busy}
                    >
                      Reject
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

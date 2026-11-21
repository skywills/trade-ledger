import { useEffect, useState } from "react";
import { z } from "zod";
import { listEnvelopeSchema } from "../../shared/api.js";
import { useJson } from "../api.js";
import { ErrorPanel, Loading } from "../components.js";
import { proposalSummary } from "./proposalSummary.js";

const History = listEnvelopeSchema(
  z.object({
    id: z.string(),
    sequence: z.number(),
    kind: z.string(),
    payload: z.record(z.string(), z.unknown()),
    effective: z.boolean(),
    supersedesId: z.string().nullable(),
  }),
);
const savedEvent = "journal-decision-saved";
export function notifyDecisionSaved() {
  window.dispatchEvent(new Event(savedEvent));
}

export function DecisionHistory({
  strategyId,
  decisionId,
}: {
  strategyId?: string;
  decisionId?: string;
}) {
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (decisionId) params.set("decisionId", decisionId);
  if (strategyId) params.set("strategyId", strategyId);
  const history = useJson(`/api/decisions?${params}`, History);
  useEffect(() => {
    function refresh() {
      setPage(1);
      history.reload();
    }
    window.addEventListener(savedEvent, refresh);
    return () => window.removeEventListener(savedEvent, refresh);
  }, [history.reload]);
  if (history.status === "loading")
    return <Loading label="Loading retained decisions…" />;
  if (!history.data)
    return (
      <ErrorPanel
        message="Could not load retained decisions."
        onRetry={history.reload}
      />
    );
  return (
    <>
      {history.data.items.length ? (
        <ol>
          {history.data.items.map((entry) => (
            <li key={entry.id}>
              <strong>
                #{entry.sequence} {entry.kind.replaceAll("_", " ")}
              </strong>
              {!entry.effective && " · Superseded"}
              {proposalSummary(entry).map((line) => (
                <p key={line}>{line}</p>
              ))}
            </li>
          ))}
        </ol>
      ) : (
        <p>
          {decisionId
            ? "This retained decision could not be found."
            : "No retained decisions."}
        </p>
      )}
      {history.data.total > history.data.pageSize && (
        <nav className="ledger-paging" aria-label="Decision history pages">
          <button
            type="button"
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>
            Page {page} of{" "}
            {Math.ceil(history.data.total / history.data.pageSize)}
          </span>
          <button
            type="button"
            disabled={page * history.data.pageSize >= history.data.total}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
    </>
  );
}

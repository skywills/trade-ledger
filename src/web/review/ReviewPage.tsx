import { ReviewEnvelope, useJson } from "../api.js";
import { BuildBadge, ErrorPanel, Loading } from "../components.js";
import { Link } from "../navigation.js";
import { AnalysisPanel } from "./AnalysisPanel.js";
import { DecisionEditor, listDecisions } from "./DecisionEditor.js";

/** Review queue plus the manual reconciliation editor and revision history. */
export function ReviewPage() {
  const remote = useJson("/api/review?pageSize=100", ReviewEnvelope);
  const history = listDecisions();

  return (
    <section>
      <h2>Review</h2>
      <BuildBadge
        buildId={remote.data?.buildId ?? null}
        stale={remote.data?.stale ?? false}
      />
      {remote.status === "loading" ? (
        <Loading label="Loading review items…" />
      ) : remote.status === "error" ? (
        <ErrorPanel
          message="Failed to load review items."
          onRetry={remote.reload}
        />
      ) : (
        <table aria-label="Review items">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Code</th>
              <th>Sources</th>
            </tr>
          </thead>
          <tbody>
            {(remote.data?.items ?? []).map((issue) => (
              <tr key={issue.key}>
                <td>{issue.severity}</td>
                <td>{issue.code}</td>
                <td>
                  {issue.sources.length === 0
                    ? "—"
                    : issue.sources.map((source) => (
                        <Link
                          key={`${source.importId}:${source.rowNumber}`}
                          to={`/imports?import=${source.importId}&row=${source.rowNumber}`}
                        >
                          {source.rowNumber}{" "}
                        </Link>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <DecisionEditor />

      <AnalysisPanel />

      <section data-testid="revision-history">
        <h3>Revision history (this session)</h3>
        {history.length === 0 ? (
          <p className="muted">No decisions submitted yet.</p>
        ) : (
          <ol>
            {history.map((entry) => (
              <li key={entry.id}>
                #{entry.sequence} {entry.kind}: {entry.summary}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

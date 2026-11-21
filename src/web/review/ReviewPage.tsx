import { Decimal } from "decimal.js";
import { JournalEnvelope, ReviewEnvelope, useJson } from "../api.js";
import { BuildBadge, ErrorPanel, Loading, TableScroll } from "../components.js";
import { LifecycleListSchema } from "../lifecycles/api.js";
import { ConnectionQueue } from "../lifecycles/ConnectionQueue.js";
import { connectionGroups, reviewLabel } from "../lifecycles/connections.js";
import { Link } from "../navigation.js";
import { AskAgent, PastAnalyses } from "./AgentReview.js";
import { DecisionEditor, listDecisions } from "./DecisionEditor.js";

/** Review queue plus the manual reconciliation editor and revision history. */
export function ReviewPage() {
  const remote = useJson("/api/review?pageSize=100", ReviewEnvelope);
  const history = listDecisions();
  const journal = useJson("/api/journal?pageSize=100", JournalEnvelope);
  const currentJournal =
    journal.data?.buildId === remote.data?.buildId ? journal.data : null;
  const connections = useJson("/api/lifecycles", LifecycleListSchema);
  const currentConnections =
    connections.data?.buildId === remote.data?.buildId
      ? connections.data
      : null;
  const grouped =
    currentConnections?.lifecycles &&
    connectionGroups(
      currentConnections.lifecycles.suggestions,
      currentConnections.lifecycles.members,
      currentConnections.connectionExecutions,
    );
  const connectionIssueKeys = new Set(
    (grouped || []).flatMap((g) =>
      g.suggestions.map((s) => `lifecycle:${s.id}`),
    ),
  );
  const remainingIssues = (remote.data?.items ?? []).filter(
    (issue) => !connectionIssueKeys.has(issue.key),
  );

  return (
    <section>
      <h2>Review</h2>
      {remote.data && (
        <BuildBadge buildId={remote.data.buildId} stale={remote.data.stale} />
      )}
      {currentConnections && (
        <ConnectionQueue
          data={currentConnections}
          onChanged={() => {
            connections.reload();
            remote.reload();
          }}
        />
      )}
      {remote.status === "loading" ? (
        <Loading label="Loading review items…" />
      ) : remote.status === "error" ? (
        <ErrorPanel
          message="Failed to load review items."
          onRetry={remote.reload}
        />
      ) : (
        <>
          {remainingIssues.length > 0 && (
            <TableScroll label="Review items table">
              <table aria-label="Review items">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Code</th>
                    <th>Affected items</th>
                    <th>Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {remainingIssues.map((issue) => (
                    <tr key={issue.key}>
                      <td>
                        <span
                          className={`badge ${issue.severity === "error" ? "badge-danger" : "badge-warn"}`}
                        >
                          <span aria-hidden="true">
                            {issue.severity === "error" ? "✕" : "⚠"}
                          </span>
                          {issue.severity}
                        </span>
                      </td>
                      <td>
                        {issue.code === "PENDING_CALL_ATTACHMENT"
                          ? reviewLabel([issue.code])
                          : issue.code}
                        {(issue.code === "EVENT_CASH_UNRESOLVED" ||
                          issue.code.startsWith("cash_settlement_")) && (
                          <p>{reviewLabel([issue.code])}</p>
                        )}
                      </td>
                      <td>
                        {(() => {
                          const legacy =
                            !issue.reconciliation && issue.owners.length === 0
                              ? (
                                  currentConnections?.lifecycles?.lifecycles ??
                                  []
                                )
                                  .filter(
                                    (cycle) =>
                                      cycle.reasons.includes(issue.code) &&
                                      currentConnections?.lifecycles?.members.some(
                                        (member) =>
                                          member.lifecycleId === cycle.id &&
                                          member.sources.some((source) =>
                                            issue.sources.some(
                                              (ref) =>
                                                ref.importId ===
                                                  source.importId &&
                                                ref.rowNumber ===
                                                  source.rowNumber,
                                            ),
                                          ),
                                      ),
                                  )
                                  .map((cycle) => ({
                                    kind: "lifecycle" as const,
                                    id: cycle.id,
                                  }))
                              : [];
                          const owners = issue.owners.length
                            ? issue.owners
                            : legacy;
                          if (!owners.length) return "Unattributed issue";
                          return owners.map((owner) => {
                            const label =
                              owner.kind === "lifecycle"
                                ? currentConnections?.lifecycles?.lifecycles.find(
                                    (cycle) => cycle.id === owner.id,
                                  )?.description
                                : currentJournal?.items.find(
                                    (strategy) => strategy.id === owner.id,
                                  )?.description;
                            return (
                              <p key={`${owner.kind}:${owner.id}`}>
                                <Link
                                  to={`/${owner.kind === "strategy" ? "strategies" : "lifecycles"}/${encodeURIComponent(owner.id)}?expectedBuildId=${encodeURIComponent(remote.data?.buildId ?? "")}`}
                                >
                                  {label ?? owner.id}
                                </Link>
                              </p>
                            );
                          });
                        })()}
                        {issue.reconciliation &&
                          (() => {
                            const { brokerPnl, reconstructedPnl, currency } =
                              issue.reconciliation;
                            const difference = new Decimal(
                              reconstructedPnl,
                            ).minus(brokerPnl);
                            return (
                              <div>
                                <p>
                                  Broker: {brokerPnl} {currency}
                                </p>
                                <p>
                                  Reconstructed: {reconstructedPnl} {currency}
                                </p>
                                <p>
                                  Difference:{" "}
                                  {difference.isPositive() ? "+" : ""}
                                  {difference.toString()} {currency}
                                </p>
                              </div>
                            );
                          })()}
                      </td>
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
            </TableScroll>
          )}
          {remote.data?.buildId && remote.data.items.length === 0 ? (
            <p className="empty-state">
              No review issues in the active build. Nothing needs attention.
            </p>
          ) : null}
        </>
      )}

      <AskAgent
        issueKeys={[
          ...new Set(
            (remote.data?.items ?? []).flatMap((issue) => issue.issueKeys),
          ),
        ]}
      />
      <PastAnalyses />

      <DecisionEditor />

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

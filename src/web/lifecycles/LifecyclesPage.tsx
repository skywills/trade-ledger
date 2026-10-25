import { formatMoney } from "../../shared/money.js";
import { useJson } from "../api.js";
import { BuildBadge, ErrorPanel, Loading, TableScroll } from "../components.js";
import { Link } from "../navigation.js";
import { LifecycleListSchema } from "./api.js";
import { BuildAction } from "./BuildAction.js";
import { ConnectionQueue } from "./ConnectionQueue.js";
import { reviewLabel } from "./connections.js";
import "./lifecycles.css";
export function LifecyclesPage() {
  const remote = useJson("/api/lifecycles", LifecycleListSchema);
  if (remote.status === "loading")
    return <Loading label="Loading lifecycles…" />;
  if (!remote.data)
    return (
      <ErrorPanel
        message={remote.error?.message ?? "Unable to load lifecycles."}
        onRetry={remote.reload}
      />
    );
  const data = remote.data;
  const projection = data.lifecycles;
  return (
    <section className="lifecycles">
      <h2>Trade lifecycles</h2>
      <p>
        Follow each trade from its first options through assignment, covered
        calls and final disposal. A lifecycle completes when every holding is
        closed and its history is complete.
      </p>
      <BuildBadge buildId={data.buildId} stale={data.stale} />
      {(data.stale || data.rebuildRequired) && (
        <div className="error-panel">
          <p>
            {data.rebuildRequired
              ? "Rebuild the journal to view lifecycle results."
              : "Inputs changed. Rebuild to activate the latest decisions."}
          </p>
          <BuildAction onBuilt={remote.reload} />
        </div>
      )}
      <ConnectionQueue data={data} onChanged={remote.reload} />
      {projection && (
        <>
          <TableScroll label="Trade lifecycles">
            <table aria-label="Trade lifecycles">
              <thead>
                <tr>
                  <th>Lifecycle</th>
                  <th>Account</th>
                  <th>Stage</th>
                  <th>Position</th>
                  <th>Review</th>
                  <th>Broker P&amp;L</th>
                  <th>Reconstructed P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {projection.lifecycles.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <Link
                        to={`/lifecycles/${encodeURIComponent(l.id)}?expectedBuildId=${encodeURIComponent(data.buildId ?? "")}`}
                      >
                        {l.description || l.id}
                      </Link>
                    </td>
                    <td>{l.account}</td>
                    <td>{l.stage.replaceAll("_", " ")}</td>
                    <td>{l.positions.length ? "Open" : "Closed"}</td>
                    <td>
                      {l.reasons.includes("PENDING_CALL_ATTACHMENT")
                        ? "Connection pending"
                        : l.status === "unresolved"
                          ? "Needs review"
                          : "Complete"}
                    </td>
                    <td>{formatMoney(l.brokerPnl, l.currency)}</td>
                    <td>{formatMoney(l.reconstructedPnl, l.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {!projection.lifecycles.length && (
            <p>
              No lifecycles yet. <Link to="/imports">Import trades</Link> to
              begin.
            </p>
          )}
          <h3>Wheel campaigns</h3>
          <p>
            Campaigns group independent cycles; they do not add trades to
            performance counts.
          </p>
          <ul>
            {projection.campaigns.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/campaigns/${encodeURIComponent(c.id)}?expectedBuildId=${encodeURIComponent(data.buildId ?? "")}`}
                >
                  {c.name}
                </Link>{" "}
                · {c.lifecycleIds.length} cycles
              </li>
            ))}
          </ul>
          {projection.issues.some(
            (i) => i.code !== "PENDING_CALL_ATTACHMENT",
          ) && (
            <aside aria-label="Lifecycle issues">
              <h3>Needs review</h3>
              <ul>
                {projection.issues
                  .filter((i) => i.code !== "PENDING_CALL_ATTACHMENT")
                  .map((i) => (
                    <li key={i.key}>{reviewLabel([i.code])}</li>
                  ))}
              </ul>
            </aside>
          )}
        </>
      )}
    </section>
  );
}

import { type KeyboardEvent, useMemo, useState } from "react";
import { formatMoney } from "../../shared/money.js";
import {
  type Execution,
  LotsEnvelope,
  StrategyDetailSchema,
  TransactionsEnvelope,
  useJson,
} from "../api.js";
import { BuildBadge, ErrorPanel, Loading } from "../components.js";
import { LifecycleListSchema } from "../lifecycles/api.js";
import { Link } from "../navigation.js";
import { DecisionEditor, listDecisions } from "../review/DecisionEditor.js";
import { collectActualExpiries } from "./expiries.js";

const TABS = ["Summary", "Allocations", "Lots", "History"] as const;
type Tab = (typeof TABS)[number];

function sourceTarget(execution: Execution | undefined): string | null {
  const source = execution?.sources[0];
  if (source === undefined) return null;
  return `/imports?import=${source.importId}&row=${source.rowNumber}`;
}

/** Strategy detail: source precision, ledger allocations, lots and decisions. */
export function StrategyDetail({ id }: { id: string }) {
  const lifecycles = useJson("/api/lifecycles", LifecycleListSchema);
  const detail = useJson(`/api/strategies/${id}`, StrategyDetailSchema);
  const transactions = useJson(
    "/api/transactions?pageSize=100",
    TransactionsEnvelope,
  );
  const lots = useJson("/api/lots?pageSize=100", LotsEnvelope);
  const [tab, setTab] = useState<Tab>("Summary");

  const executionByKey = useMemo(() => {
    const map = new Map<string, Execution>();
    for (const execution of transactions.data?.items ?? []) {
      map.set(execution.key, execution);
    }
    return map;
  }, [transactions.data]);

  if (detail.status === "loading") {
    return <Loading label="Loading strategy…" testId="strategy-loading" />;
  }
  if (detail.status === "error") {
    return (
      <ErrorPanel
        message={detail.error?.message ?? "Failed to load the strategy."}
        onRetry={detail.reload}
      />
    );
  }

  const { strategy, allocations, links } = detail.data ?? {};
  if (
    strategy === undefined ||
    allocations === undefined ||
    links === undefined
  ) {
    return <ErrorPanel message="Strategy not found." />;
  }

  const history = listDecisions(id);

  function onTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.indexOf(tab);
    const last = TABS.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const name = TABS[target] ?? "Summary";
    setTab(name);
    document.getElementById(`strategy-tab-${name}`)?.focus();
  }

  // Actual contract expiry dates behind the strategy, so a "Mixed" label in
  // the journal can be understood without leaving the detail view.
  const actualExpiries = collectActualExpiries(
    allocations.map((allocation) => allocation.executionKey),
    executionByKey,
  );

  return (
    <section>
      <p>
        <Link to="/journal">← Journal</Link>
      </p>
      <h2>{strategy.description}</h2>
      <BuildBadge
        buildId={detail.data?.buildId ?? null}
        stale={detail.data?.stale ?? false}
      />

      {(lifecycles.data?.lifecycles?.lifecycles ?? [])
        .filter((l) => l.componentIds.includes(id))
        .map((l) => (
          <p key={l.id}>
            <Link
              to={`/lifecycles/${encodeURIComponent(l.id)}?expectedBuildId=${encodeURIComponent(lifecycles.data?.buildId ?? "")}`}
            >
              View full trade lifecycle: {l.description}
            </Link>
          </p>
        ))}
      <div role="tablist" aria-label="Strategy views" onKeyDown={onTabKeyDown}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`strategy-tab-${name}`}
            aria-selected={tab === name}
            aria-controls="strategy-panel"
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id="strategy-panel"
        aria-labelledby={`strategy-tab-${tab}`}
      >
        {tab === "Summary" ? (
          <div className="card-grid">
            <section className="card">
              <h3>Position</h3>
              <dl>
                <dt>Type</dt>
                <dd>{strategy.type}</dd>
                <dt>Status</dt>
                <dd>{strategy.status.replaceAll("_", " ")}</dd>
                <dt>Currency</dt>
                <dd>{strategy.currency}</dd>
                <dt>Open date</dt>
                <dd>{strategy.openingDate ?? "—"}</dd>
                <dt>Close date</dt>
                <dd>{strategy.closeDate ?? "—"}</dd>
                <dt>Expiry</dt>
                <dd>{strategy.expiry ?? "—"}</dd>
                <dt>Contract expiries (actual)</dt>
                <dd data-testid="actual-expiries">
                  {actualExpiries.length > 0 ? actualExpiries.join(", ") : "—"}
                </dd>
                <dt>Expiry year</dt>
                <dd>{strategy.expiryYear ?? "—"}</dd>
                <dt>Complete</dt>
                <dd>{strategy.complete ? "Yes" : "No"}</dd>
              </dl>
            </section>
            <section className="card">
              <h3>Profit, loss and cash</h3>
              <dl>
                <dt>Debit/credit (source precision)</dt>
                <dd className="num">
                  {strategy.openingAmount ?? "Unavailable"}
                </dd>
                <dt>Cashflow (source precision)</dt>
                <dd className="num">{strategy.cashflow ?? "Unavailable"}</dd>
                <dt>Broker realized P/L (source precision)</dt>
                <dd className="num">{strategy.brokerPnl ?? "Unavailable"}</dd>
                <dt>Reconstructed P/L (source precision)</dt>
                <dd className="num">
                  {strategy.reconstructedPnl ?? "Unavailable"}
                </dd>
                <dt>Debit/credit (display)</dt>
                <dd className="num">
                  {formatMoney(strategy.openingAmount, strategy.currency)}
                </dd>
              </dl>
            </section>
            <section className="card">
              <h3>Notes and risk</h3>
              <dl>
                <dt>Notes</dt>
                <dd data-testid="strategy-notes">
                  {detail.data?.metadata.notes ?? "—"}
                </dd>
                <dt>Stop loss</dt>
                <dd data-testid="strategy-stop-loss">
                  {detail.data?.metadata.stopLoss ?? "—"}
                </dd>
                <dt>Reasons</dt>
                <dd>
                  {strategy.reasons.length > 0
                    ? strategy.reasons.join(", ")
                    : "—"}
                </dd>
              </dl>
            </section>
          </div>
        ) : null}

        {tab === "Allocations" ? (
          <table aria-label="Allocations">
            <thead>
              <tr>
                <th>Role</th>
                <th>Execution</th>
                <th>Quantity</th>
                <th>Net cash</th>
                <th>Broker P/L</th>
                <th>Estimated</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map((allocation) => {
                const target = sourceTarget(
                  executionByKey.get(allocation.executionKey),
                );
                return (
                  <tr key={`${allocation.executionKey}-${allocation.role}`}>
                    <td>{allocation.role}</td>
                    <td>{allocation.executionKey}</td>
                    <td>{allocation.quantity}</td>
                    <td>{allocation.netCash}</td>
                    <td>{allocation.brokerPnl ?? "Unavailable"}</td>
                    <td>{allocation.pnlEstimated ? "Yes" : "No"}</td>
                    <td>
                      {target === null ? (
                        "—"
                      ) : (
                        <Link to={target}>View source</Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        {tab === "Lots" ? (
          <table aria-label="Lots">
            <thead>
              <tr>
                <th>Row</th>
                <th>Kind</th>
                <th>Symbol</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {(lots.data?.items ?? []).map((lot) => {
                const source = lot.issues[0]?.sources[0];
                const target =
                  source === undefined
                    ? null
                    : `/imports?import=${source.importId}&row=${source.rowNumber}`;
                return (
                  <tr key={lot.rowNumber}>
                    <td>{lot.rowNumber}</td>
                    <td>{lot.kind}</td>
                    <td>{lot.fields.Symbol ?? "—"}</td>
                    <td>
                      {target === null ? (
                        "—"
                      ) : (
                        <Link to={target}>View source</Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}

        {tab === "History" ? (
          <div data-testid="strategy-history">
            <h3>Retained revision history</h3>
            {history.length === 0 ? (
              <p className="muted">
                No decisions submitted this session. Retained decisions remain
                server-side across rebuilds.
              </p>
            ) : (
              <ol>
                {history.map((entry) => (
                  <li key={entry.id}>
                    #{entry.sequence} {entry.kind}: {entry.summary}
                  </li>
                ))}
              </ol>
            )}
            <h4>Grouping links</h4>
            <ul>
              {links.map((link) => (
                <li key={`${link.from}-${link.to}-${link.type}`}>
                  {link.type}: {link.from} → {link.to}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <DecisionEditor
        fixedStrategyId={id}
        initialNotes={detail.data?.metadata.notes ?? null}
        initialStopLoss={detail.data?.metadata.stopLoss ?? null}
      />
    </section>
  );
}

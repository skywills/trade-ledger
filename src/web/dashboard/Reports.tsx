import { useState } from "react";
import type { AnalyticsResponse } from "../../shared/analytics.js";
import { formatMoney } from "../../shared/money.js";
import { Link } from "../navigation.js";
import { Overview } from "./Overview.js";
export function Reports({ data }: { data: AnalyticsResponse }) {
  const [notes, setNotes] = useState("");
  const c = data.filters.currency ?? "";
  return (
    <article className="dashboard-report">
      <header className="dashboard-report-heading">
        <div>
          <p className="dashboard-eyebrow">TRADELEDGER · PERIOD REVIEW</p>
          <h3>Trading report</h3>
          <p>
            {data.filters.from ?? "First available trade"} —{" "}
            {data.filters.to ?? "Latest available trade"} · {c} ·{" "}
            {data.filters.basis === "broker"
              ? "Broker reported"
              : "Reconstructed"}{" "}
            P&amp;L
          </p>
        </div>
        <button
          type="button"
          className="dashboard-print-button"
          onClick={() => window.print()}
        >
          Print / Save as PDF
        </button>
      </header>
      <p className="dashboard-report-provenance">
        Build {data.buildId} · Ledger {data.ledgerId}
        <br />
        Generated {data.generatedAt} ·{" "}
        {data.filters.unit === "strategy"
          ? "Strategy components"
          : "Trade lifecycles"}
        {data.stale ? " · Stale: inputs changed since this build" : ""}
      </p>
      <div
        className="dashboard-report-active-filters"
        data-testid="report-active-filters"
      >
        {[
          data.filters.campaignId
            ? `Campaign: ${data.filters.campaignId}`
            : null,
          data.filters.account ? `Account: ${data.filters.account}` : null,
          data.filters.symbol ? `Symbol: ${data.filters.symbol}` : null,
          data.filters.underlying
            ? `Underlying: ${data.options.underlyings.find((item) => item.key === data.filters.underlying)?.label ?? (data.filters.underlying === "__multi__" ? "Multi-underlying" : data.filters.underlying === "__unknown__" ? "Unknown" : data.filters.underlying.replace(/^value:/, ""))}`
            : null,
          data.filters.strategyType
            ? `Strategy type: ${data.filters.strategyType}`
            : null,
          data.filters.assetClass
            ? `Asset class: ${data.filters.assetClass}`
            : null,
        ]
          .filter(Boolean)
          .map((filter) => (
            <span key={filter}>{filter}</span>
          ))}
      </div>
      <Overview data={data} />
      <div className="dashboard-two-column">
        <article className="dashboard-panel">
          <h3>Largest winners</h3>
          {data.best.map((s) => (
            <p className="dashboard-ranking" key={s.id}>
              <Link
                to={`/${data.filters.unit === "strategy" ? "strategies" : "lifecycles"}/${encodeURIComponent(s.id)}?expectedBuildId=${encodeURIComponent(data.buildId ?? "")}`}
              >
                {s.description || s.id}
              </Link>
              <strong>{formatMoney(s.selectedPnl, c)}</strong>
            </p>
          ))}
          {!data.best.length && (
            <p className="dashboard-muted">No winning trades in this scope.</p>
          )}
        </article>
        <article className="dashboard-panel">
          <h3>Largest losers</h3>
          {data.worst.map((s) => (
            <p className="dashboard-ranking" key={s.id}>
              <Link
                to={`/${data.filters.unit === "strategy" ? "strategies" : "lifecycles"}/${encodeURIComponent(s.id)}?expectedBuildId=${encodeURIComponent(data.buildId ?? "")}`}
              >
                {s.description || s.id}
              </Link>
              <strong>{formatMoney(s.selectedPnl, c)}</strong>
            </p>
          ))}
          {!data.worst.length && (
            <p className="dashboard-muted">No losing trades in this scope.</p>
          )}
        </article>
      </div>
      <article className="dashboard-panel">
        <h3>Transaction activity and costs</h3>
        <dl className="dashboard-report-facts">
          <div>
            <dt>Executions / symbols</dt>
            <dd>
              {data.transactions.executions} / {data.transactions.tradedSymbols}
            </dd>
          </div>
          <div>
            <dt>Trading cashflow ({c})</dt>
            <dd>{formatMoney(data.transactions.netCash, c)}</dd>
          </div>
          <div>
            <dt>Commissions · charges / credits ({c})</dt>
            <dd>
              {formatMoney(data.transactions.commissions.value, c)} ·{" "}
              {data.transactions.commissions.known} /{" "}
              {data.transactions.commissions.total} known
            </dd>
          </div>
          <div>
            <dt>Taxes ({c})</dt>
            <dd>
              {formatMoney(data.transactions.taxes.value, c)} ·{" "}
              {data.transactions.taxes.known} / {data.transactions.taxes.total}{" "}
              known
            </dd>
          </div>
        </dl>
        <p className="dashboard-muted">
          Transactions use execution dates. Negative charges are costs, positive
          values are credits. Fees have not been subtracted again from P&amp;L.
        </p>
      </article>
      <article className="dashboard-panel">
        <h3>Data quality and scope</h3>
        <ul>
          <li>
            P&amp;L coverage: {data.performance.eligible} of{" "}
            {data.performance.closed}{" "}
            {data.filters.unit === "strategy"
              ? "closed strategy components"
              : "completed lifecycles"}
            . Missing amounts are excluded, never treated as zero.
          </li>
          <li>
            {data.quality.undatedClosed}{" "}
            {data.filters.unit === "strategy"
              ? "closed strategy components"
              : "completed lifecycles"}{" "}
            with unknown dates excluded; {data.quality.unresolved} unresolved{" "}
            {data.filters.unit === "strategy"
              ? "strategy components"
              : "lifecycles"}
            .
          </li>
          <li>
            {data.quality.estimatedClosed}{" "}
            {data.filters.unit === "strategy"
              ? "closed strategy components"
              : "completed lifecycles"}{" "}
            include estimated broker allocations.
          </li>
          <li>
            {data.quality.excludedUnallocated} unallocated executions excluded
            by strategy-specific filters.
          </li>
          <li>
            Current context:{" "}
            {data.performance.open + data.performance.partiallyClosed} open or
            partially closed{" "}
            {data.filters.unit === "strategy"
              ? "strategy components"
              : "lifecycles"}{" "}
            in this build; this is not a historical period-end position count.
          </li>
          <li>
            Dates follow normalized ledger calendar dates; unknown source
            timezones are not inferred. Currency values are not converted.
          </li>
          <li>
            Cumulative realized P&amp;L and drawdown describe closed-trade
            results, not account equity or unrealized positions.
          </li>
        </ul>
      </article>
      <article className="dashboard-panel dashboard-review-notes">
        <h3>Review notes</h3>
        <label className="dashboard-notes-label">
          Unsaved review notes
          <textarea
            rows={5}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What worked? What will you change next period?"
          />
        </label>
        <p className="dashboard-muted dashboard-notes-help">
          Notes are unsaved, stay in this view, and are included when you print.
        </p>
        <div className="dashboard-print-notes" data-testid="report-print-notes">
          {notes || "No review notes entered."}
        </div>
      </article>
    </article>
  );
}

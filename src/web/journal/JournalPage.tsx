import { useMemo, useState } from "react";
import { formatMoney } from "../../shared/money.js";
import { JournalEnvelope, type Strategy, useJson } from "../api.js";
import { BuildBadge, ErrorPanel, Loading } from "../components.js";
import { Link } from "../navigation.js";

const STATUS_LABEL: Record<Strategy["status"], string> = {
  open: "Open",
  partially_closed: "Partially closed",
  closed: "Closed",
  unresolved: "Unresolved",
};

function positionsText(strategy: Strategy): string {
  if (strategy.positions.length === 0) return "—";
  return strategy.positions.map((entry) => entry.quantity).join(", ");
}

/**
 * The journal table. Columns mirror the required layout; every monetary value
 * is rendered from the server's string with `formatMoney`, and a null amount
 * shows `Unavailable`. There is intentionally no summed P/L across currencies.
 */
export function JournalPage() {
  const remote = useJson("/api/journal?pageSize=100", JournalEnvelope);
  const [currency, setCurrency] = useState("");

  const items = remote.data?.items ?? [];
  const currencies = useMemo(
    () => [...new Set(items.map((entry) => entry.currency))].sort(),
    [items],
  );
  const rows = currency
    ? items.filter((entry) => entry.currency === currency)
    : items;

  if (remote.status === "loading") {
    return <Loading label="Loading journal…" testId="journal-loading" />;
  }
  if (remote.status === "error") {
    return (
      <ErrorPanel
        message={remote.error?.message ?? "Failed to load the journal."}
        onRetry={remote.reload}
      />
    );
  }

  return (
    <section>
      <h2>Journal</h2>
      <BuildBadge
        buildId={remote.data?.buildId ?? null}
        stale={remote.data?.stale ?? false}
      />
      <p>
        <label>
          Currency{" "}
          <select
            aria-label="Currency"
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            <option value="">All currencies</option>
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </p>
      <table aria-label="Journal">
        <thead>
          <tr>
            <th>Open date</th>
            <th>Close date</th>
            <th>Status</th>
            <th>Expiry</th>
            <th>Year</th>
            <th>Symbol / description</th>
            <th>Quantity / remaining</th>
            <th>Debit / credit</th>
            <th>Broker realized P/L</th>
            <th>Reconstructed P/L</th>
            <th>Completeness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((strategy) => (
            <tr key={strategy.id}>
              <td data-column="openDate">{strategy.openingDate ?? "—"}</td>
              <td data-column="closeDate">{strategy.closeDate ?? "—"}</td>
              <td data-column="status">{STATUS_LABEL[strategy.status]}</td>
              <td data-column="expiry">{strategy.expiry ?? "—"}</td>
              <td data-column="year">{strategy.expiryYear ?? "—"}</td>
              <td data-column="description">
                <Link to={`/strategies/${strategy.id}`}>
                  {strategy.description}
                </Link>
              </td>
              <td data-column="quantity">{positionsText(strategy)}</td>
              <td data-column="debitCredit">
                {formatMoney(strategy.openingAmount, strategy.currency)}
              </td>
              <td data-column="brokerPnl">
                {formatMoney(strategy.brokerPnl, strategy.currency)}
              </td>
              <td data-column="reconstructedPnl">
                {formatMoney(strategy.reconstructedPnl, strategy.currency)}
              </td>
              <td data-column="completeness">
                {strategy.complete ? "Complete" : "Incomplete"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p data-testid="journal-empty">
          No strategies in the active build. Import a flex CSV and rebuild.
        </p>
      ) : null}
    </section>
  );
}

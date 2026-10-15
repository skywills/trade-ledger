import { useMemo, useState } from "react";
import { formatMoney } from "../../shared/money.js";
import { JournalEnvelope, type Strategy, useJson } from "../api.js";
import {
  BuildBadge,
  ErrorPanel,
  Loading,
  pnlClass,
  TableScroll,
} from "../components.js";
import { Link } from "../navigation.js";
import {
  filterStrategies,
  nextSort,
  type SortKey,
  type SortState,
  sortStrategies,
} from "./journalView.js";

const STATUS_LABEL: Record<Strategy["status"], string> = {
  open: "Open",
  partially_closed: "Partially closed",
  closed: "Closed",
  unresolved: "Unresolved",
};

const STATUS_BADGE: Record<Strategy["status"], string> = {
  open: "badge-accent",
  partially_closed: "badge-warn",
  closed: "",
  unresolved: "badge-danger",
};

function positionsText(strategy: Strategy): string {
  if (strategy.positions.length === 0) return "—";
  return strategy.positions.map((entry) => entry.quantity).join(", ");
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: SortKey;
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
}) {
  const active = sort?.key === column ? sort.direction : null;
  const ariaSort =
    active === "asc" ? "ascending" : active === "desc" ? "descending" : "none";
  return (
    <th aria-sort={ariaSort}>
      <button
        type="button"
        className="sort-button"
        onClick={() => onSort(nextSort(sort, column))}
      >
        {label}
        <span aria-hidden="true" className="sort-indicator">
          {active === "asc" ? "▲" : active === "desc" ? "▼" : "↕"}
        </span>
      </button>
    </th>
  );
}

/**
 * The journal table. Columns mirror the required layout; every monetary value
 * is rendered from the server's string with `formatMoney`, and a null amount
 * shows `Unavailable`. There is intentionally no summed P/L across currencies.
 */
export function JournalPage() {
  const remote = useJson("/api/journal?pageSize=100", JournalEnvelope);
  const [currency, setCurrency] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);

  const items = remote.data?.items;
  const currencies = useMemo(
    () => [...new Set((items ?? []).map((entry) => entry.currency))].sort(),
    [items],
  );
  const rows = useMemo(
    () =>
      sortStrategies(
        filterStrategies(items ?? [], { currency, status, query }),
        sort,
      ),
    [items, currency, status, query, sort],
  );
  const total = items?.length ?? 0;
  const filtering = currency !== "" || status !== "" || query.trim() !== "";

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
      <div className="toolbar">
        <label>
          Search{" "}
          <input
            type="search"
            aria-label="Search strategies"
            placeholder="Symbol or description"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
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
        <label>
          Status{" "}
          <select
            aria-label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {filtering ? (
          <button
            type="button"
            onClick={() => {
              setCurrency("");
              setStatus("");
              setQuery("");
            }}
          >
            Clear filters
          </button>
        ) : null}
        <p className="muted toolbar-count" role="status">
          {rows.length} of {total} strategies
        </p>
      </div>
      <TableScroll label="Journal table">
        <table aria-label="Journal">
          <thead>
            <tr>
              <SortHeader
                label="Open date"
                column="openingDate"
                sort={sort}
                onSort={setSort}
              />
              <SortHeader
                label="Close date"
                column="closeDate"
                sort={sort}
                onSort={setSort}
              />
              <SortHeader
                label="Status"
                column="status"
                sort={sort}
                onSort={setSort}
              />
              <SortHeader
                label="Expiry"
                column="expiry"
                sort={sort}
                onSort={setSort}
              />
              <th>Year</th>
              <SortHeader
                label="Symbol / description"
                column="description"
                sort={sort}
                onSort={setSort}
              />
              <th>Quantity / remaining</th>
              <SortHeader
                label="Debit / credit"
                column="openingAmount"
                sort={sort}
                onSort={setSort}
              />
              <SortHeader
                label="Broker realized P/L"
                column="brokerPnl"
                sort={sort}
                onSort={setSort}
              />
              <SortHeader
                label="Reconstructed P/L"
                column="reconstructedPnl"
                sort={sort}
                onSort={setSort}
              />
              <th>Completeness</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((strategy) => (
              <tr key={strategy.id}>
                <td data-column="openDate">{strategy.openingDate ?? "—"}</td>
                <td data-column="closeDate">{strategy.closeDate ?? "—"}</td>
                <td data-column="status">
                  <span className={`badge ${STATUS_BADGE[strategy.status]}`}>
                    {STATUS_LABEL[strategy.status]}
                  </span>
                </td>
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
                <td
                  data-column="brokerPnl"
                  className={pnlClass(strategy.brokerPnl)}
                >
                  {formatMoney(strategy.brokerPnl, strategy.currency)}
                </td>
                <td
                  data-column="reconstructedPnl"
                  className={pnlClass(strategy.reconstructedPnl)}
                >
                  {formatMoney(strategy.reconstructedPnl, strategy.currency)}
                </td>
                <td data-column="completeness">
                  <span
                    className={`badge ${strategy.complete ? "badge-success" : "badge-warn"}`}
                  >
                    {strategy.complete ? "Complete" : "Incomplete"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {rows.length === 0 ? (
        total > 0 ? (
          <p className="empty-state" data-testid="journal-no-matches">
            No strategies match these filters.
          </p>
        ) : (
          <p className="empty-state" data-testid="journal-empty">
            No strategies in the active build.{" "}
            <Link to="/imports">Import a flex CSV</Link> and rebuild.
          </p>
        )
      ) : null}
    </section>
  );
}

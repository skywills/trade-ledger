import {
  isJournalSortKey,
  nextSort,
  type SortKey,
  type SortState,
} from "../../shared/journal-view.js";
import { formatMoney } from "../../shared/money.js";
import { JournalPageEnvelope, type Strategy, useJson } from "../api.js";
import {
  BuildBadge,
  ErrorPanel,
  Loading,
  PageLinks,
  pageNumber,
  pnlClass,
  TableScroll,
} from "../components.js";
import { Link, navigate, useQuery } from "../navigation.js";

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
  const params = useQuery();
  const page = pageNumber(params.get("page"));
  const currency = params.get("currency") ?? "";
  const status = params.get("status") ?? "";
  const query = params.get("q") ?? "";
  const key = params.get("sort");
  const sort: SortState | null = isJournalSortKey(key)
    ? { key, direction: params.get("order") === "desc" ? "desc" : "asc" }
    : null;
  const filtered = Boolean(currency || status || query.trim());
  const hasFilterInput = Boolean(currency || status || query);
  const api = new URLSearchParams({ pageSize: "100", page: String(page) });
  if (currency) api.set("currency", currency);
  if (status) api.set("status", status);
  if (query.trim()) api.set("q", query.trim());
  if (sort) {
    api.set("sort", sort.key);
    api.set("order", sort.direction);
  }
  const remote = useJson(`/api/journal?${api}`, JournalPageEnvelope);
  const rows = remote.data?.items ?? [];
  const total = remote.data?.total ?? 0;
  const currencies = remote.data?.currencies ?? [];

  function href(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    return next.size ? `/journal?${next}` : "/journal";
  }

  function update(changes: Record<string, string>, replace = false) {
    navigate(href({ ...changes, page: "" }), { replace });
  }

  function setSort(next: SortState | null) {
    update({ sort: next?.key ?? "", order: next?.direction ?? "" });
  }

  if (remote.status === "loading" && !remote.data) {
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
      <p>
        <Link to="/lifecycles">View complete trade lifecycles</Link>
      </p>
      <BuildBadge
        buildId={remote.data?.buildId ?? null}
        stale={remote.data?.stale ?? false}
      />
      {(currencies.length > 0 || hasFilterInput) && (
        <div className="toolbar">
          <label>
            Search{" "}
            <input
              type="search"
              aria-label="Search strategies"
              placeholder="Symbol or description"
              value={query}
              onChange={(event) => update({ q: event.target.value }, true)}
            />
          </label>
          <label>
            Currency{" "}
            <select
              aria-label="Currency"
              value={currency}
              onChange={(event) => update({ currency: event.target.value })}
            >
              <option value="">All currencies</option>
              {(currency && !currencies.includes(currency)
                ? [...currencies, currency]
                : currencies
              ).map((code) => (
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
              onChange={(event) => update({ status: event.target.value })}
            >
              <option value="">All statuses</option>
              {status && !Object.hasOwn(STATUS_LABEL, status) && (
                <option value={status}>{status}</option>
              )}
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {hasFilterInput ? (
            <button
              type="button"
              onClick={() => update({ q: "", currency: "", status: "" })}
            >
              Clear filters
            </button>
          ) : null}
          <p className="muted toolbar-count" role="status">
            {remote.status === "loading"
              ? "Updating results…"
              : `${total} ${filtered ? "matching " : ""}${total === 1 ? "strategy" : "strategies"}`}
          </p>
        </div>
      )}
      {rows.length > 0 && (
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
                    <Link to={`/strategies/${encodeURIComponent(strategy.id)}`}>
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
      )}
      {remote.data && (
        <PageLinks {...remote.data} href={(n) => href({ page: String(n) })} />
      )}
      {remote.status === "ready" &&
      rows.length === 0 &&
      remote.data?.buildId ? (
        total > 0 ? (
          <p className="empty-state">
            No strategies on this page.{" "}
            <Link to={href({ page: "" })}>Go to the first page</Link>
          </p>
        ) : filtered ? (
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

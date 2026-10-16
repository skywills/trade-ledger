import type { DetailQuery } from "../../shared/analytics.js";
import { formatMoney } from "../../shared/money.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import { ErrorPanel, Loading, TableScroll } from "../components.js";
import { Link, navigate, useLocation } from "../navigation.js";
import { useAnalyticsDetails } from "./api.js";
import { dashboardHref, localToday, readDashboardQuery } from "./query.js";
export function DetailTable({
  query,
  onRefresh,
}: {
  query: DetailQuery;
  onRefresh?: (() => void) | undefined;
}) {
  const remote = useAnalyticsDetails(query);
  const { search } = useLocation();
  const state = readDashboardQuery(search, "analysis", localToday());
  const update = (patch: Record<string, string>) =>
    navigate(
      dashboardHref("analysis", {
        ...state,
        detail: {
          kind: query.kind,
          ...(query.expectedBuildId
            ? { expectedBuildId: query.expectedBuildId }
            : {}),
          ...state.detail,
          ...patch,
        },
      }),
    );
  const titles = {
    closed: "Closed trades",
    "current-open": "Current open trades",
    unresolved: "Unresolved strategies",
    "undated-closed": "Closed trades with unknown dates",
  };
  const title =
    query.kind === "transactions" ? "Transaction details" : titles[query.scope];
  if (remote.status === "loading")
    return <Loading label="Loading matching records…" />;
  if (remote.status === "error")
    return remote.error?.code === "ANALYTICS_BUILD_CHANGED" ? (
      <div className="dashboard-warning" role="alert">
        <p>{remote.error.message}</p>
        <button
          type="button"
          onClick={() => {
            const { expectedBuildId: _old, ...detail } = state.detail;
            navigate(dashboardHref("analysis", { ...state, detail }));
            onRefresh?.();
          }}
        >
          Refresh analytics
        </button>
      </div>
    ) : (
      <ErrorPanel
        message={remote.error?.message ?? "Could not load details."}
        onRetry={remote.reload}
      />
    );
  const data = remote.data;
  if (!data) return null;
  const currency = data.filters.currency ?? "";
  const sortHeader = (key: string, label: string) => (
    <th
      aria-sort={
        query.sort === key
          ? query.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        className="dashboard-sort"
        type="button"
        onClick={() =>
          update({
            sort: key,
            direction:
              query.sort === key && query.direction === "desc" ? "asc" : "desc",
            page: "1",
          })
        }
      >
        {label} <span aria-hidden="true">↕</span>
      </button>
    </th>
  );
  return (
    <article className="dashboard-panel">
      <div className="dashboard-panel-heading">
        <h3>{title}</h3>
        <span className="dashboard-unit">
          {data.total} records · {currency}
        </span>
      </div>
      {query.scope !== "closed" && (
        <p className="dashboard-muted">
          Current build scope; period bounds do not filter this list.
        </p>
      )}
      {query.group && (
        <p className="dashboard-muted">
          Group: {query.group.replace(/^value:/, "")}
        </p>
      )}
      <TableScroll label={`${title} scroll`}>
        <table aria-label={title}>
          <thead>
            {data.kind === "strategies" ? (
              <tr>
                <th>Trade</th>
                <th>Type</th>
                {sortHeader("closeDate", "Closed")}
                <th>Status</th>
                {sortHeader("pnl", `P&L (${currency})`)}
              </tr>
            ) : (
              <tr>
                {sortHeader("date", "Date")}
                {sortHeader("symbol", "Symbol")}
                <th>Underlying</th>
                <th>Asset class</th>
                <th>Action / event</th>
                {sortHeader("quantity", "Quantity")}
                <th>Price</th>
                {sortHeader("netCash", `Net cash (${currency})`)}
                <th>Commission</th>
                <th>Taxes</th>
                <th>Broker P&L</th>
                <th>Source</th>
              </tr>
            )}
          </thead>
          <tbody>
            {data.kind === "strategies"
              ? data.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/strategies/${encodeURIComponent(s.id)}`}>
                        {s.description || s.id}
                      </Link>
                    </td>
                    <td>{s.type}</td>
                    <td>{s.closeDate ?? "Unknown"}</td>
                    <td>{s.status.replaceAll("_", " ")}</td>
                    <td>{formatMoney(s.selectedPnl, currency)}</td>
                  </tr>
                ))
              : data.items.map((e) => (
                  <tr key={e.key}>
                    <td>{e.date}</td>
                    <td>{e.instrument.symbol}</td>
                    <td>{underlyingSymbol(e.instrument)}</td>
                    <td>{e.instrument.assetClass}</td>
                    <td>
                      {e.action} / {e.event.replaceAll("_", " ")}
                    </td>
                    <td>{e.quantity}</td>
                    <td>{formatMoney(e.price, currency)}</td>
                    <td>{formatMoney(e.netCash, currency)}</td>
                    <td>{formatMoney(e.commission, currency)}</td>
                    <td>{formatMoney(e.taxes, currency)}</td>
                    <td>{formatMoney(e.brokerPnl, currency)}</td>
                    <td>
                      {e.sources[0] ? (
                        <Link
                          to={`/imports?import=${encodeURIComponent(e.sources[0].importId)}&row=${e.sources[0].rowNumber}`}
                        >
                          View source
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </TableScroll>
      {!data.items.length && (
        <p className="dashboard-muted">No matching records.</p>
      )}
      <div className="dashboard-pagination">
        <button
          type="button"
          disabled={data.page <= 1}
          onClick={() => update({ page: String(data.page - 1) })}
        >
          Previous page
        </button>
        <span>
          Page {data.page} of{" "}
          {Math.max(1, Math.ceil(data.total / data.pageSize))}
        </span>
        <button
          type="button"
          disabled={data.page * data.pageSize >= data.total}
          onClick={() => update({ page: String(data.page + 1) })}
        >
          Next page
        </button>
      </div>
    </article>
  );
}

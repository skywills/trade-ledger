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
  view = "analysis",
}: {
  query: DetailQuery;
  view?: "analysis" | "open-positions";
  onRefresh?: (() => void) | undefined;
}) {
  const remote = useAnalyticsDetails(query);
  const { search } = useLocation();
  const state = readDashboardQuery(search, view, localToday());
  const update = (patch: Record<string, string>) =>
    navigate(
      dashboardHref(view, {
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
  const openPositions = view === "open-positions";
  const lifecycle = query.unit !== "strategy";
  const titles = {
    closed: lifecycle ? "Completed lifecycles" : "Closed strategy components",
    "estimated-closed": lifecycle
      ? "Completed lifecycles with estimated broker P&L"
      : "Closed strategy components with estimated broker P&L",
    "current-open": lifecycle
      ? "Current open lifecycles"
      : "Current open strategy components",
    unresolved: lifecycle
      ? "Unresolved lifecycles"
      : "Unresolved strategy components",
    "undated-closed": lifecycle
      ? "Completed lifecycles with unknown dates"
      : "Closed strategy components with unknown dates",
  };
  const title = openPositions
    ? "Open positions"
    : query.kind === "transactions"
      ? "Transaction details"
      : titles[query.scope];
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
            navigate(dashboardHref(view, { ...state, detail }));
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
      {query.scope !== "closed" && query.scope !== "estimated-closed" && (
        <p className="dashboard-muted">
          Current build scope; period bounds do not filter this list.
        </p>
      )}
      {query.scope === "estimated-closed" && (
        <p className="dashboard-muted">
          Broker P&amp;L includes amounts allocated from shared executions. Open
          a trade to inspect its source evidence.
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
                {openPositions && <th>Underlying</th>}
                <th>Type</th>
                {openPositions ? (
                  <>
                    <th>Remaining quantity</th>
                    <th>Opened</th>
                    <th>Expiry</th>
                  </>
                ) : (
                  sortHeader("closeDate", "Closed")
                )}
                <th>Status</th>
                {!openPositions && sortHeader("pnl", `P&L (${currency})`)}
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
                      <Link
                        to={`/${lifecycle ? "lifecycles" : "strategies"}/${encodeURIComponent(s.id)}?expectedBuildId=${encodeURIComponent(data.buildId ?? "")}`}
                      >
                        {s.description || s.id}
                      </Link>
                    </td>
                    {openPositions && (
                      <td>
                        {s.underlying === "__unknown__"
                          ? "Unknown"
                          : s.underlying === "__multi__"
                            ? "Multiple"
                            : s.underlying.replace(/^value:/, "")}
                      </td>
                    )}
                    <td>{s.type}</td>
                    {openPositions ? (
                      <>
                        <td>
                          {s.positions.length
                            ? s.positions.map((position) => (
                                <div key={position.instrumentKey}>
                                  {position.quantity}
                                  {s.positions.length > 1 &&
                                    ` · ${position.instrumentKey}`}
                                </div>
                              ))
                            : "—"}
                        </td>
                        <td>{s.openingDate ?? "Unknown"}</td>
                        <td>{s.expiry ?? "—"}</td>
                      </>
                    ) : (
                      <td>{s.closeDate ?? "Unknown"}</td>
                    )}
                    <td>{s.status.replaceAll("_", " ")}</td>
                    {!openPositions && (
                      <td>{formatMoney(s.selectedPnl, currency)}</td>
                    )}
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

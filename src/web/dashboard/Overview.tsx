import type { AnalyticsResponse } from "../../shared/analytics.js";
import { formatMoney } from "../../shared/money.js";
import { Link, navigate } from "../navigation.js";
import { BreakdownTable } from "./BreakdownTable.js";
import { AnalyticsChart } from "./Charts.js";
import { KpiCards } from "./KpiCards.js";
import { detailHref } from "./query.js";
export function Overview({ data }: { data: AnalyticsResponse }) {
  const currency = data.filters.currency ?? "";
  return (
    <>
      <KpiCards data={data} />
      <div className="dashboard-charts-grid">
        <AnalyticsChart
          title="Cumulative realized P&L"
          currency={currency}
          points={data.daily.map((p) => ({
            key: p.date,
            label: p.date,
            value: p.pnl === null ? null : p.cumulative,
          }))}
          onSelect={(date) =>
            navigate(detailHref(data, { kind: "strategies", date }))
          }
        />
        <AnalyticsChart
          title="Monthly realized P&L"
          currency={currency}
          variant="bar"
          points={data.monthly.map((p) => ({
            key: p.month,
            label: p.month,
            value: p.pnl,
          }))}
          onSelect={(month) =>
            navigate(
              detailHref(
                {
                  ...data,
                  filters: {
                    ...data.filters,
                    from:
                      data.filters.from && data.filters.from > `${month}-01`
                        ? data.filters.from
                        : `${month}-01`,
                    to:
                      data.filters.to && data.filters.to < `${month}-31`
                        ? data.filters.to
                        : new Date(
                            Date.UTC(
                              Number(month.slice(0, 4)),
                              Number(month.slice(5)),
                              0,
                            ),
                          )
                            .toISOString()
                            .slice(0, 10),
                  },
                },
                { kind: "strategies" },
              ),
            )
          }
        />
      </div>
      <div className="dashboard-two-column">
        <BreakdownTable
          title="Performance by strategy"
          rows={data.byStrategyType}
          currency={currency}
          onSelect={(group) =>
            navigate(
              detailHref(data, {
                kind: "strategies",
                groupBy: "strategyType",
                group,
              }),
            )
          }
        />
        <BreakdownTable
          title="Performance by underlying"
          rows={data.byUnderlying}
          currency={currency}
          onSelect={(group) =>
            navigate(
              detailHref(data, {
                kind: "strategies",
                groupBy: "underlying",
                group,
              }),
            )
          }
        />
      </div>
      <article className="dashboard-panel">
        <div className="dashboard-panel-heading">
          <h3>Recent closed trades</h3>
          <Link to={detailHref(data, { kind: "strategies" })}>
            View all trades ↗
          </Link>
        </div>
        <div
          className="dashboard-table-scroll"
          role="region"
          aria-label="Recent trades scroll"
          tabIndex={0}
        >
          <table aria-label="Recent closed trades">
            <thead>
              <tr>
                <th>Trade</th>
                <th>Strategy</th>
                <th>Closed</th>
                <th>P&L ({currency})</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/strategies/${encodeURIComponent(s.id)}`}>
                      {s.description || s.id}
                    </Link>
                  </td>
                  <td>{s.type}</td>
                  <td>{s.closeDate}</td>
                  <td
                    className={
                      s.selectedPnl?.startsWith("-")
                        ? "dashboard-loss"
                        : "dashboard-profit"
                    }
                  >
                    {formatMoney(s.selectedPnl, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.recent.length && (
          <p className="dashboard-muted">
            No closed trades in this period. Adjust the date range to explore
            your history.
          </p>
        )}
      </article>
      <article className="dashboard-activity-strip">
        <div>
          <span className="dashboard-eyebrow">TRANSACTION ACTIVITY</span>
          <p>
            <strong>{data.transactions.executions}</strong> executions across{" "}
            <strong>{data.transactions.tradedSymbols}</strong> symbols
          </p>
        </div>
        <Link to={detailHref(data, { kind: "transactions" })}>
          Explore transactions
        </Link>
      </article>
    </>
  );
}

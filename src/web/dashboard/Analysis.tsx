import { Decimal } from "decimal.js";
import {
  type AnalyticsResponse,
  DetailQuerySchema,
  type GroupRow,
} from "../../shared/analytics.js";
import { formatMoney } from "../../shared/money.js";
import { Link, navigate, useLocation } from "../navigation.js";
import { AnalyticsChart } from "./Charts.js";
import { DetailTable } from "./DetailTable.js";
import { Overview } from "./Overview.js";
import {
  dashboardHref,
  detailHref,
  localToday,
  readDashboardQuery,
} from "./query.js";
export function ContributionBars({
  title,
  rows,
  currency,
  onSelect,
}: {
  title: string;
  rows: readonly GroupRow[];
  currency: string;
  onSelect: ((key: string) => void) | undefined;
}) {
  const max = rows.reduce(
    (m, r) => Decimal.max(m, new Decimal(r.pnl ?? 0).abs()),
    new Decimal(1),
  );
  return (
    <article className="dashboard-panel">
      <div className="dashboard-panel-heading">
        <h3>{title}</h3>
        <span className="dashboard-unit">{currency}</span>
      </div>
      {rows.slice(0, 10).map((r) => (
        <button
          type="button"
          className="dashboard-contribution"
          key={r.key}
          onClick={() => onSelect?.(r.key)}
        >
          <span>{r.label}</span>
          <span className="dashboard-contribution-track">
            <span
              className={
                r.pnl?.startsWith("-") ? "dashboard-contribution-loss" : ""
              }
              style={{
                width: `${new Decimal(r.pnl ?? 0).abs().div(max).times(100).toNumber()}%`,
              }}
            />
          </span>
          <strong>{formatMoney(r.pnl, currency)}</strong>
        </button>
      ))}
      {!rows.length && (
        <p className="dashboard-muted">No available contributions.</p>
      )}
    </article>
  );
}
export function Analysis({
  data,
  section,
  onRefresh,
}: {
  data: AnalyticsResponse;
  section: "performance" | "transactions";
  onRefresh?: (() => void) | undefined;
}) {
  const { search } = useLocation();
  const state = readDashboardQuery(search, "analysis", localToday());
  const currency = data.filters.currency ?? "";
  const detail = state.detail.kind
    ? DetailQuerySchema.safeParse({
        ...data.filters,
        ...state.detail,
        expectedBuildId:
          state.detail.expectedBuildId ?? data.buildId ?? undefined,
      })
    : null;
  const back = dashboardHref("analysis", { ...state, detail: {} });
  const chartPoints = (key: "executions" | "netCash") =>
    data.monthly.map((p) => ({
      key: p.month,
      label: p.month,
      value: key === "executions" ? String(p.executions) : p.netCash,
    }));
  return (
    <>
      <nav className="dashboard-subtabs" aria-label="Analysis sections">
        {(["performance", "transactions"] as const).map((s) => (
          <Link
            key={s}
            to={dashboardHref("analysis", { ...state, section: s, detail: {} })}
            aria-current={section === s ? "page" : undefined}
          >
            {s === "performance" ? "Performance" : "Transactions"}
          </Link>
        ))}
      </nav>
      {state.detail.kind ? (
        <>
          <div className="dashboard-detail-bar">
            <Link to={back}>Back to analysis</Link>
            <span>
              {state.detail.outcome ? `Outcome: ${state.detail.outcome}` : ""}
              {state.detail.date ? ` · ${state.detail.date}` : ""}
            </span>
          </div>
          {detail?.success ? (
            <DetailTable query={detail.data} onRefresh={onRefresh} />
          ) : (
            <p role="alert" className="dashboard-warning">
              Invalid detail filters. Return to analysis to reset.
            </p>
          )}
        </>
      ) : section === "performance" ? (
        <>
          <div className="dashboard-outcomes">
            {(
              [
                ["win", "Wins", data.performance.wins],
                ["loss", "Losses", data.performance.losses],
                ["breakeven", "Breakeven", data.performance.breakeven],
                ["unavailable", "Unavailable P&L", data.performance.missing],
              ] as const
            ).map(([outcome, label, count]) => (
              <Link
                key={outcome}
                to={detailHref(data, { kind: "strategies", outcome })}
              >
                {label} <strong>{count}</strong>
              </Link>
            ))}
          </div>
          <Overview data={data} />
          <div className="dashboard-two-column">
            <AnalyticsChart
              title="Realized drawdown"
              currency={currency}
              points={data.daily.map((p) => ({
                key: p.date,
                label: p.date,
                value: p.pnl === null ? null : p.drawdown,
              }))}
              onSelect={(date) =>
                navigate(detailHref(data, { kind: "strategies", date }))
              }
            />
            <article className="dashboard-panel">
              <h3>Largest winners and losers</h3>
              {[...data.best.slice(0, 5), ...data.worst.slice(0, 5)].map(
                (s) => (
                  <p className="dashboard-ranking" key={s.id}>
                    <Link
                      to={`/${data.filters.unit === "strategy" ? "strategies" : "lifecycles"}/${encodeURIComponent(s.id)}?expectedBuildId=${encodeURIComponent(data.buildId ?? "")}`}
                    >
                      {s.description || s.id}
                    </Link>
                    <strong
                      className={
                        s.selectedPnl?.startsWith("-")
                          ? "dashboard-loss"
                          : "dashboard-profit"
                      }
                    >
                      {formatMoney(s.selectedPnl, currency)}
                    </strong>
                  </p>
                ),
              )}
            </article>
          </div>
          <div className="dashboard-two-column">
            <ContributionBars
              title="Strategy contributions"
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
            <ContributionBars
              title="Underlying contributions"
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
        </>
      ) : (
        <>
          <p className="dashboard-muted">
            Transactions follow execution dates. Their cashflow can differ from
            P&amp;L attributed to strategy close dates.
          </p>
          <div className="dashboard-secondary-kpis">
            <div>
              <span>Executions</span>
              <strong>{data.transactions.executions}</strong>
            </div>
            <div>
              <span>Traded symbols</span>
              <strong>{data.transactions.tradedSymbols}</strong>
            </div>
            <div>
              <span>Trading cashflow ({currency})</span>
              <strong>
                {formatMoney(data.transactions.netCash, currency)}
              </strong>
            </div>
            <div>
              <span>Charges / credits</span>
              <strong>
                {formatMoney(data.transactions.commissions.value, currency)}
              </strong>
              <span>
                Commission · {data.transactions.commissions.known} /{" "}
                {data.transactions.commissions.total} known
              </span>
              <span>
                Taxes: {formatMoney(data.transactions.taxes.value, currency)} ·{" "}
                {data.transactions.taxes.known} /{" "}
                {data.transactions.taxes.total} known
              </span>
            </div>
          </div>
          <p className="dashboard-muted">
            Charges are signed: negative values are costs, positive values are
            credits. P&amp;L is not adjusted again.
          </p>
          <div className="dashboard-two-column">
            <AnalyticsChart
              title="Monthly executions"
              currency="executions"
              valueType="count"
              points={chartPoints("executions")}
              variant="bar"
            />
            <AnalyticsChart
              title="Monthly trading cashflow"
              currency={currency}
              points={chartPoints("netCash")}
              variant="bar"
            />
          </div>
          <div className="dashboard-two-column">
            {(
              [
                [
                  "assetClass",
                  "Activity by asset class",
                  data.transactions.byAssetClass,
                ],
                ["event", "Activity by event", data.transactions.byEvent],
              ] as const
            ).map(([groupBy, title, rows]) => (
              <AnalyticsChart
                key={groupBy}
                title={title}
                currency="executions"
                valueType="count"
                variant="bar"
                points={rows.map((r) => ({
                  key: r.key,
                  label: r.label,
                  value: String(r.count),
                }))}
                onSelect={(group) =>
                  navigate(
                    detailHref(data, { kind: "transactions", groupBy, group }),
                  )
                }
              />
            ))}
          </div>
          <DetailTable
            query={{
              ...data.filters,
              kind: "transactions",
              scope: "closed",
              page: 1,
              pageSize: 25,
              direction: "desc",
              expectedBuildId: data.buildId ?? undefined,
            }}
            onRefresh={onRefresh}
          />
        </>
      )}
    </>
  );
}

import { Decimal } from "decimal.js";
import type { AnalyticsResponse } from "../../shared/analytics.js";
import { formatMoney } from "../../shared/money.js";
import { Link } from "../navigation.js";
import { detailHref } from "./query.js";
export function rate(value: string | null): string {
  return value === null
    ? "Unavailable"
    : `${new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)}%`;
}
export function KpiCards({ data }: { data: AnalyticsResponse }) {
  const p = data.performance;
  const money = (v: string | null) =>
    formatMoney(v, data.filters.currency ?? "");
  const main = [
    {
      key: "pnl",
      label: "Realized P&L",
      value: money(p.pnl),
      detail: `${data.filters.currency ?? ""} · ${p.missing ? `${p.missing} missing values` : "Closed trades only"}`,
      scope: "closed",
    },
    {
      key: "win-rate",
      label: "Win rate",
      value: rate(p.winRatePct),
      detail: `${p.wins} wins · ${p.losses} losses · ${p.breakeven} breakeven`,
      scope: "closed",
    },
    {
      key: "closed",
      label: "Closed trades",
      value: String(p.closed),
      detail: `${p.eligible} with available P&L`,
      scope: "closed",
    },
    {
      key: "open",
      label: "Current open trades",
      value: String(p.open + p.partiallyClosed),
      detail: `${p.open} open · ${p.partiallyClosed} partially closed`,
      scope: "current-open",
    },
  ];
  return (
    <>
      <div className="dashboard-kpis">
        {main.map((c) => (
          <Link
            className={`dashboard-kpi ${c.key === "pnl" ? "dashboard-kpi-primary" : ""}`}
            key={c.key}
            to={detailHref(data, { kind: "strategies", scope: c.scope })}
            data-testid={`metric-${c.key}`}
          >
            <span className="dashboard-kpi-label">
              {c.label}
              <span aria-hidden="true">↗</span>
            </span>
            <strong
              className={
                c.key === "pnl" && p.pnl !== null
                  ? p.pnl.startsWith("-")
                    ? "dashboard-loss"
                    : "dashboard-profit"
                  : ""
              }
            >
              {c.value}
            </strong>
            <span className="dashboard-kpi-detail">{c.detail}</span>
          </Link>
        ))}
      </div>
      <div className="dashboard-secondary-kpis">
        {[
          { label: "Average win", value: money(p.averageWin) },
          { label: "Average loss", value: money(p.averageLoss) },
          {
            label: "Profit factor",
            value:
              p.profitFactor.state === "no-losses"
                ? "No losses"
                : p.profitFactor.value === null
                  ? "Unavailable"
                  : new Decimal(p.profitFactor.value).toFixed(2),
          },
          { label: "Average P&L / trade", value: money(p.averagePnl) },
        ].map((c) => (
          <div key={c.label}>
            <span>{c.label}</span>
            <strong>{c.value}</strong>
          </div>
        ))}
      </div>
    </>
  );
}

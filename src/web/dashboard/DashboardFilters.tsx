import { useState } from "react";
import type {
  AnalyticsQuery,
  AnalyticsResponse,
} from "../../shared/analytics.js";
import { navigate } from "../navigation.js";
import {
  changeDashboard,
  type DashboardQueryState,
  type DashboardView,
  dashboardHref,
  localToday,
  readDashboardQuery,
} from "./query.js";
export function DashboardFilters({
  state,
  view,
  data,
}: {
  state: DashboardQueryState;
  view: DashboardView;
  data: AnalyticsResponse | null;
}) {
  const [from, setFrom] = useState(state.query.from ?? "");
  const [to, setTo] = useState(state.query.to ?? "");
  function change(patch: Partial<AnalyticsQuery>) {
    navigate(dashboardHref(view, changeDashboard(state, patch)));
  }
  return (
    <div className="dashboard-filters">
      <div className="dashboard-filter-row">
        <label>
          Count by
          <select
            value={state.query.unit ?? "lifecycle"}
            onChange={(e) =>
              change({
                unit: e.target.value as "lifecycle" | "strategy",
                campaignId: undefined,
              })
            }
          >
            <option value="lifecycle">Trade lifecycles</option>
            <option value="strategy">Strategy components</option>
          </select>
        </label>
        <label>
          Period
          <select
            value={state.preset}
            onChange={(e) => {
              const p = new URLSearchParams();
              p.set("preset", e.target.value);
              for (const [k, v] of Object.entries(state.query))
                if (v && k !== "from" && k !== "to") p.set(k, v);
              navigate(
                dashboardHref(
                  view,
                  readDashboardQuery(`?${p}`, view, localToday()),
                ),
              );
            }}
          >
            <option value="all">All time</option>
            <option value="this-month">This month</option>
            <option value="last-month">Last month</option>
            <option value="this-year">This year</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        <label>
          Currency
          <select
            value={state.query.currency ?? data?.filters.currency ?? ""}
            onChange={(e) => change({ currency: e.target.value })}
          >
            <option value="" disabled>
              Select currency
            </option>
            {(
              data?.options.currencies ??
              (state.query.currency ? [state.query.currency] : [])
            ).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          P&amp;L basis
          <select
            value={state.query.basis}
            onChange={(e) =>
              change({ basis: e.target.value as AnalyticsQuery["basis"] })
            }
          >
            <option value="broker">Broker reported</option>
            <option value="reconstructed">Reconstructed</option>
          </select>
        </label>
        <button
          type="button"
          className="dashboard-reset"
          onClick={() =>
            navigate(
              dashboardHref(
                view,
                readDashboardQuery("?preset=all", view, localToday()),
              ),
            )
          }
        >
          Reset filters
        </button>
      </div>
      {state.preset === "custom" && (
        <form
          className="dashboard-filter-row"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(
              dashboardHref(view, {
                ...changeDashboard(state, {
                  from: from || undefined,
                  to: to || undefined,
                }),
                preset: "custom",
              }),
            );
          }}
        >
          <label>
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <button type="submit">Apply dates</button>
        </form>
      )}
      {(view === "analysis" || view === "open-positions") && (
        <div className="dashboard-filter-row dashboard-advanced-filters">
          {(
            [
              [
                "symbol",
                "Symbol",
                data?.options.symbols.map((value) => ({
                  value,
                  label: value,
                })) ?? [],
              ],
              [
                "underlying",
                "Underlying",
                data?.options.underlyings.map((item) => ({
                  value: item.key,
                  label: item.label,
                })) ?? [],
              ],
              [
                "strategyType",
                "Strategy type",
                data?.options.strategyTypes.map((value) => ({
                  value,
                  label: value,
                })) ?? [],
              ],
              [
                "assetClass",
                "Asset class",
                data?.options.assetClasses.map((value) => ({
                  value,
                  label: value,
                })) ?? [],
              ],
            ] as const
          ).map(([key, label, options]) => (
            <label key={key}>
              {label}
              <select
                aria-label={label}
                value={state.query[key] ?? ""}
                onChange={(e) => change({ [key]: e.target.value || undefined })}
              >
                <option value="">All</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      <div className="dashboard-filter-chips">
        {(["symbol", "underlying", "strategyType", "assetClass"] as const)
          .filter((key) => state.query[key])
          .map((key) => (
            <button
              type="button"
              key={key}
              onClick={() => change({ [key]: undefined })}
              aria-label={`Remove ${key} filter`}
            >
              {key}: {state.query[key]?.replace(/^value:/, "")} ×
            </button>
          ))}
      </div>
    </div>
  );
}

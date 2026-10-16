import { useEffect } from "react";
import { BuildBadge, ErrorPanel, Loading } from "../components.js";
import { Link, useLocation } from "../navigation.js";
import { Analysis } from "./Analysis.js";
import { useAnalytics } from "./api.js";
import { DashboardFilters } from "./DashboardFilters.js";
import { Overview } from "./Overview.js";
import {
  type DashboardView,
  dashboardHref,
  localToday,
  readDashboardQuery,
} from "./query.js";
import "./dashboard.css";
export function DashboardPage({ view }: { view: DashboardView }) {
  const { search } = useLocation();
  const state = readDashboardQuery(search, view, localToday());
  const remote = useAnalytics(state.query, !state.error);
  const data = remote.status === "ready" ? remote.data : null;
  useEffect(() => {
    if (data?.filters.currency && !state.query.currency) {
      const href = dashboardHref(view, {
        ...state,
        query: { ...state.query, currency: data.filters.currency },
      });
      window.history.replaceState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  }, [data, state, view]);
  return (
    <section className="dashboard">
      <div className="dashboard-title">
        <div>
          <p className="dashboard-eyebrow">TRADING PERFORMANCE</p>
          <h2>Dashboard</h2>
          <p className="dashboard-subtitle">
            Your trading story, backed by the numbers.
          </p>
        </div>
        <span className="dashboard-date">
          {state.query.from ?? "All available history"}
          {state.query.to ? ` — ${state.query.to}` : ""}
        </span>
      </div>
      <nav className="dashboard-tabs" aria-label="Dashboard views">
        {(["overview", "analysis", "reports"] as const).map((v) => (
          <Link
            key={v}
            to={dashboardHref(v, state)}
            aria-current={view === v ? "page" : undefined}
          >
            {v === "overview"
              ? "Overview"
              : v === "analysis"
                ? "Analysis"
                : "Reports"}
          </Link>
        ))}
      </nav>
      <DashboardFilters
        key={`${state.query.from}|${state.query.to}`}
        state={state}
        view={view}
        data={data}
      />
      {state.error ? (
        <p role="alert" className="dashboard-warning">
          {state.error}
        </p>
      ) : remote.status === "loading" ? (
        <div className="dashboard-loading">
          <Loading label="Loading analytics…" />
        </div>
      ) : remote.status === "error" ? (
        <ErrorPanel
          message={remote.error?.message ?? "Unable to load analytics."}
          onRetry={remote.reload}
        />
      ) : data ? (
        <>
          <div className="dashboard-provenance">
            <BuildBadge buildId={data.buildId} stale={data.stale} />
            <span>
              {data.performance.eligible} / {data.performance.closed} closed
              trades with{" "}
              {data.filters.basis === "broker" ? "broker" : "reconstructed"}{" "}
              P&amp;L · {data.filters.currency ?? "No currency"}
            </span>
          </div>
          {!data.buildId ? (
            <div className="dashboard-empty">
              <h3>Start your trading story</h3>
              <p>
                Import your trades and build the journal to see performance.
              </p>
              <Link to="/imports">Import trades</Link>
            </div>
          ) : (
            <div data-testid="dashboard-content">
              {view === "overview" ? (
                <Overview data={data} />
              ) : view === "analysis" ? (
                <Analysis
                  data={data}
                  section={state.section}
                  onRefresh={remote.reload}
                />
              ) : (
                <p>Trading report</p>
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

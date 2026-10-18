import { useEffect } from "react";
import { ExportQuerySchema } from "../../shared/analytics.js";
import { BuildBadge, ErrorPanel, Loading } from "../components.js";
import { BuildAction } from "../lifecycles/BuildAction.js";
import { Link, navigate, useLocation } from "../navigation.js";
import { Analysis } from "./Analysis.js";
import { useAnalytics } from "./api.js";
import { DashboardFilters } from "./DashboardFilters.js";
import { DataQuality } from "./DataQuality.js";
import { ExportButton } from "./ExportButton.js";
import { Overview } from "./Overview.js";
import {
  type DashboardView,
  dashboardHref,
  localToday,
  readDashboardQuery,
} from "./query.js";
import { Reports } from "./Reports.js";
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
  const exportDataset =
    state.detail.kind === "strategies"
      ? "strategies"
      : state.detail.kind === "transactions"
        ? "transactions"
        : "summary";
  const {
    page: _page,
    pageSize: _size,
    kind: _kind,
    sort: _sort,
    direction: _direction,
    ...exportDetail
  } = state.detail;
  const exportQuery = data
    ? ExportQuerySchema.safeParse({
        ...data.filters,
        ...exportDetail,
        dataset: exportDataset,
        expectedBuildId:
          state.detail.expectedBuildId ?? data.buildId ?? undefined,
      })
    : null;
  function refreshAnalytics() {
    const { expectedBuildId: _old, ...detail } = state.detail;
    navigate(dashboardHref(view, { ...state, detail }));
    remote.reload();
  }
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
      {data?.buildId && exportQuery?.success && (
        <ExportButton
          key={search}
          query={exportQuery.data}
          dataset={exportDataset}
          onRefresh={refreshAnalytics}
        />
      )}
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
        >
          {remote.error?.code === "LIFECYCLE_REBUILD_REQUIRED" && (
            <BuildAction onBuilt={refreshAnalytics} />
          )}
        </ErrorPanel>
      ) : data ? (
        <>
          <div className="dashboard-provenance">
            <BuildBadge buildId={data.buildId} stale={data.stale} />
            <span>
              {data.performance.eligible} / {data.performance.closed}{" "}
              {data.filters.unit === "strategy"
                ? "closed strategy components"
                : "completed lifecycles"}{" "}
              with{" "}
              {data.filters.basis === "broker" ? "broker" : "reconstructed"}{" "}
              P&amp;L · {data.filters.currency ?? "No currency"}
            </span>
          </div>
          <DataQuality data={data} />
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
                <Reports data={data} />
              )}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

import type { AnalyticsResponse } from "../../shared/analytics.js";
import { Link } from "../navigation.js";
import { detailHref } from "./query.js";
export function DataQuality({ data }: { data: AnalyticsResponse }) {
  const q = data.quality;
  const closed =
    data.filters.unit === "strategy"
      ? "closed strategy components"
      : "completed lifecycles";
  const units =
    data.filters.unit === "strategy" ? "strategy components" : "lifecycles";
  const hasWarnings = Boolean(
    q.undatedClosed ||
      q.unresolved ||
      q.estimatedClosed ||
      q.excludedUnallocated ||
      data.performance.missing,
  );
  if (!hasWarnings && !q.basisReconciledClosed) return null;
  return (
    <>
      {hasWarnings && (
        <aside
          className="dashboard-warning dashboard-quality"
          aria-label="Data quality"
        >
          <h3>Data quality</h3>
          {data.performance.missing > 0 && (
            <p>
              {data.performance.missing} {closed} have unavailable P&amp;L.
              Totals show the available subtotal.
            </p>
          )}
          {q.undatedClosed > 0 && (
            <p>
              <Link
                to={detailHref(data, {
                  kind: "strategies",
                  scope: "undated-closed",
                })}
              >
                {q.undatedClosed} {closed} with unknown dates
              </Link>{" "}
              · excluded from period totals
            </p>
          )}
          {q.unresolved > 0 && (
            <p>
              <Link
                to={detailHref(data, {
                  kind: "strategies",
                  scope: "unresolved",
                })}
              >
                {q.unresolved} unresolved {units}
              </Link>{" "}
              · excluded from closed-trade performance
            </p>
          )}
          {q.estimatedClosed > 0 && (
            <p>
              <Link
                to={detailHref(data, {
                  kind: "strategies",
                  scope: "estimated-closed",
                })}
              >
                {q.estimatedClosed} {closed} include estimated broker P&amp;L
              </Link>
            </p>
          )}
          {q.excludedUnallocated > 0 && (
            <p>
              {q.excludedUnallocated} unallocated executions excluded by
              strategy filters
            </p>
          )}
        </aside>
      )}
      {q.basisReconciledClosed > 0 && (
        <aside
          className="dashboard-muted dashboard-attribution"
          aria-label="P&L attribution"
        >
          <Link
            to={detailHref(data, {
              kind: "strategies",
              scope: "basis-reconciled-closed",
            })}
          >
            {q.basisReconciledClosed} {closed} include basis-reconciled broker
            P&amp;L
          </Link>{" "}
          · matched opening costs reconcile to the broker total; rounding
          adjustments are retained
        </aside>
      )}
    </>
  );
}

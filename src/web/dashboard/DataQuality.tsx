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
  if (
    !q.undatedClosed &&
    !q.unresolved &&
    !q.estimatedClosed &&
    !q.excludedUnallocated &&
    !data.performance.missing
  )
    return null;
  return (
    <aside
      className="dashboard-warning dashboard-quality"
      aria-label="Data quality"
    >
      <h3>Data quality</h3>
      {data.performance.missing > 0 && (
        <p>
          {data.performance.missing} {closed} have unavailable P&amp;L. Totals
          show the available subtotal.
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
            to={detailHref(data, { kind: "strategies", scope: "unresolved" })}
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
          {q.excludedUnallocated} unallocated executions excluded by strategy
          filters
        </p>
      )}
    </aside>
  );
}

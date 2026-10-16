import { useId, useState } from "react";
import { formatMoney } from "../../shared/money.js";
import { TableScroll } from "../components.js";
import { buildChartModel, type ChartPoint } from "./chartModel.js";
export function AnalyticsChart({
  title,
  currency,
  points,
  variant = "line",
  onSelect,
  valueType = "money",
}: {
  title: string;
  currency: string;
  points: readonly ChartPoint[];
  variant?: "line" | "bar";
  valueType?: "money" | "count";
  onSelect?: ((key: string) => void) | undefined;
}) {
  const id = useId();
  const [table, setTable] = useState(false);
  const [active, setActive] = useState(0);
  const [page, setPage] = useState(0);
  const model = buildChartModel(points);
  const chosen = points[Math.min(active, Math.max(0, points.length - 1))];
  const selected = model.points.find((p) => p.index === active);
  let path = "";
  let connected = false;
  for (const p of model.points) {
    if (p.y === null) {
      connected = false;
      continue;
    }
    path += `${connected && !p.breakBefore ? "L" : "M"}${p.x},${p.y} `;
    connected = true;
  }
  const display = (v: string | null) =>
    valueType === "count" ? (v ?? "Unavailable") : formatMoney(v, currency);
  const known = points.filter((p) => p.value !== null).length;
  return (
    <article className="dashboard-panel dashboard-chart">
      <div className="dashboard-panel-heading">
        <h3 id={id}>{title}</h3>
        <span className="dashboard-unit">{currency}</span>
      </div>
      <p className="dashboard-chart-summary">
        {points.length
          ? `${known} of ${points.length} periods with available values`
          : `No activity in this period`}
      </p>
      {points.length && known ? (
        <>
          <svg
            viewBox="0 0 640 240"
            role="img"
            aria-labelledby={id}
            className="dashboard-svg"
          >
            <title>
              {title}: {known} available values. Use the data navigator or table
              for exact values.
            </title>
            {[40, 80, 120, 160, 200].map((y) => (
              <line
                key={y}
                x1="40"
                x2="600"
                y1={y}
                y2={y}
                className="chart-grid"
              />
            ))}
            <line
              x1="40"
              x2="600"
              y1={model.zeroY}
              y2={model.zeroY}
              className="chart-zero"
            />
            {variant === "line" ? (
              <>
                <path d={path} fill="none" className="chart-line" />
                {model.points.length === 1 && model.points[0]?.y !== null ? (
                  <circle
                    cx={model.points[0]?.x}
                    cy={model.points[0]?.y ?? 0}
                    r="4"
                    className="chart-dot"
                  />
                ) : null}
                {selected?.y != null && (
                  <circle
                    cx={selected.x}
                    cy={selected.y}
                    r="5"
                    className="chart-dot"
                  />
                )}
              </>
            ) : (
              model.points.map((p) =>
                p.y === null ? null : (
                  <rect
                    key={p.index}
                    x={p.x - Math.min(24, 240 / points.length)}
                    y={Math.min(p.y, model.zeroY)}
                    width={Math.max(2, Math.min(48, 480 / points.length))}
                    height={Math.max(1, Math.abs(p.y - model.zeroY))}
                    rx="3"
                    className={
                      points[p.index]?.value?.startsWith("-")
                        ? "chart-bar-negative"
                        : "chart-bar-positive"
                    }
                  />
                ),
              )
            )}
            <text x="40" y="227">
              {points[0]?.label}
            </text>
            <text x="600" y="227" textAnchor="end">
              {points.at(-1)?.label}
            </text>
          </svg>
          <div className="dashboard-chart-legend">
            <span className="chart-legend-line" />{" "}
            {variant === "line" ? "Realized P&L" : "Signed period value"} · zero
            baseline
          </div>
          <fieldset
            className="dashboard-chart-navigator"
            aria-label={`${title} data navigator`}
          >
            <button
              type="button"
              aria-label={`Previous point in ${title}`}
              disabled={active === 0}
              onClick={() => setActive((a) => Math.max(0, a - 1))}
            >
              ←
            </button>
            <output aria-live="polite">
              {chosen?.label}: <strong>{display(chosen?.value ?? null)}</strong>{" "}
              {currency}
            </output>
            <button
              type="button"
              aria-label={`Next point in ${title}`}
              disabled={active >= points.length - 1}
              onClick={() =>
                setActive((a) => Math.min(points.length - 1, a + 1))
              }
            >
              →
            </button>
            {onSelect && chosen && (
              <button type="button" onClick={() => onSelect(chosen.key)}>
                View trades
              </button>
            )}
          </fieldset>
        </>
      ) : (
        <div className="dashboard-chart-empty">
          {points.length
            ? "P&L is unavailable for this series."
            : "No data for this period."}
        </div>
      )}
      <button
        type="button"
        className="dashboard-text-button"
        aria-expanded={table}
        onClick={() => setTable((t) => !t)}
      >
        {table ? "Hide" : "Show"} data table for {title}
      </button>
      {table && (
        <div className="dashboard-chart-data">
          <TableScroll label={`${title} data scroll`}>
            <table aria-label={`${title} data`}>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Value ({currency})</th>
                  {onSelect && <th>Details</th>}
                </tr>
              </thead>
              <tbody>
                {points.slice(page * 25, (page + 1) * 25).map((p) => (
                  <tr key={p.key}>
                    <td>{p.label}</td>
                    <td>{p.value ?? "Unavailable"}</td>
                    {onSelect && (
                      <td>
                        <button type="button" onClick={() => onSelect(p.key)}>
                          View trades
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {points.length > 25 && (
            <div className="dashboard-pagination">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous values
              </button>
              <span>
                {page + 1} / {Math.ceil(points.length / 25)}
              </span>
              <button
                type="button"
                disabled={(page + 1) * 25 >= points.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next values
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

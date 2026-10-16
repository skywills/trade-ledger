import { Decimal } from "decimal.js";
import { useState } from "react";
import type { GroupRow } from "../../shared/analytics.js";
import { formatMoney } from "../../shared/money.js";
import { TableScroll } from "../components.js";
import { rate } from "./KpiCards.js";
export function BreakdownTable({
  rows,
  currency,
  onSelect,
  title,
}: {
  rows: readonly GroupRow[];
  currency: string;
  onSelect?: ((key: string) => void) | undefined;
  title: string;
}) {
  const [sort, setSort] = useState<"pnl" | "closed" | "label">("pnl");
  const [asc, setAsc] = useState(false);
  const sorted = [...rows].sort((a, b) => {
    if (sort === "pnl" && (a.pnl === null || b.pnl === null))
      return a.pnl === null ? (b.pnl === null ? 0 : 1) : -1;
    const c =
      sort === "pnl"
        ? new Decimal(a.pnl ?? 0).cmp(b.pnl ?? 0)
        : sort === "closed"
          ? a.closed - b.closed
          : a.label.localeCompare(b.label);
    return (asc ? c : -c) || a.key.localeCompare(b.key);
  });
  return (
    <article className="dashboard-panel">
      <div className="dashboard-panel-heading">
        <h3>{title}</h3>
        <span className="dashboard-unit">{currency}</span>
      </div>
      <TableScroll label={`${title} scroll`}>
        <table aria-label={title}>
          <thead>
            <tr>
              {(
                [
                  ["label", "Group"],
                  ["pnl", "P&L"],
                  ["closed", "Trades"],
                ] as const
              ).map(([key, label]) => (
                <th
                  key={key}
                  aria-sort={
                    sort === key ? (asc ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    className="dashboard-sort"
                    onClick={() => {
                      if (sort === key) setAsc((v) => !v);
                      else {
                        setSort(key);
                        setAsc(false);
                      }
                    }}
                  >
                    {label} <span aria-hidden="true">↕</span>
                  </button>
                </th>
              ))}
              <th>Win rate</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key}>
                <td>
                  {onSelect ? (
                    <button
                      type="button"
                      className="dashboard-text-button"
                      onClick={() => onSelect(r.key)}
                    >
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </td>
                <td
                  className={
                    r.pnl?.startsWith("-")
                      ? "dashboard-loss"
                      : "dashboard-profit"
                  }
                >
                  {formatMoney(r.pnl, currency)}
                </td>
                <td>{r.closed}</td>
                <td>{rate(r.winRatePct)}</td>
                <td>
                  {r.eligible} / {r.closed}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      {!rows.length && (
        <p className="dashboard-muted">No closed trades match these filters.</p>
      )}
    </article>
  );
}

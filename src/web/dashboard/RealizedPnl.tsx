import type { AnalyticsResponse } from "../../shared/analytics.js";
import { formatMoney } from "../../shared/money.js";
import { Link, navigate } from "../navigation.js";
import { AnalyticsChart } from "./Charts.js";
import { detailHref } from "./query.js";

export function RealizedPnl({ data }: { data: AnalyticsResponse }) {
  const realized = data.realizedPnl;
  if (
    !realized ||
    data.filters.unit === "strategy" ||
    data.filters.basis !== "broker"
  )
    return null;
  const currency = data.filters.currency ?? "";
  const cards = [
    {
      key: "open-realized",
      title: "Realized P&L in open lifecycles",
      amount: realized.open,
      to: detailHref(data, { kind: "strategies", scope: "realized-open" }),
      caption: "Open and partially closed lifecycles · realized only",
    },
    {
      key: "total-realized",
      title: "Total realized P&L",
      amount: realized.total,
      to: detailHref(data, { kind: "transactions" }),
      caption: "All recorded broker realized P&L · includes open lifecycles",
    },
  ];
  const points = [
    {
      key: "completed",
      label: "Completed lifecycles",
      value: realized.completed.value,
    },
    { key: "open", label: "Open lifecycles", value: realized.open.value },
    ...(realized.unresolved.total
      ? [
          {
            key: "unresolved",
            label: "Unresolved / unallocated",
            value: realized.unresolved.value,
          },
        ]
      : []),
  ];
  return (
    <section className="dashboard-realized" aria-label="Recorded realized P&L">
      <div className="dashboard-realized-heading">
        <h3>Recorded realized P&amp;L</h3>
        <p className="dashboard-muted">
          Uses execution dates and current lifecycle status. Completed-lifecycle
          performance above uses completion dates. Unrealized P&amp;L is
          excluded.
        </p>
      </div>
      <div className="dashboard-two-column">
        {cards.map((card) => (
          <Link
            key={card.key}
            className="dashboard-kpi"
            to={card.to}
            data-testid={`metric-${card.key}`}
          >
            <span className="dashboard-kpi-label">
              {card.title}
              <span aria-hidden="true">↗</span>
            </span>
            <strong
              className={
                card.amount.value === null
                  ? ""
                  : card.amount.value.startsWith("-")
                    ? "dashboard-loss"
                    : "dashboard-profit"
              }
            >
              {formatMoney(card.amount.value, currency)}
            </strong>
            <span className="dashboard-kpi-detail">
              {currency} · {card.caption}
            </span>
            {card.amount.known < card.amount.total && (
              <span className="dashboard-kpi-detail">
                {card.amount.total - card.amount.known} missing values · known
                subtotal {formatMoney(card.amount.knownValue, currency)}
              </span>
            )}
          </Link>
        ))}
      </div>
      <AnalyticsChart
        title="Realized P&L by lifecycle status"
        currency={currency}
        variant="bar"
        pointUnit="categories"
        points={points}
        onSelect={(key) =>
          navigate(
            detailHref(
              data,
              key === "unresolved"
                ? { kind: "transactions", scope: "realized-unresolved" }
                : {
                    kind: "strategies",
                    scope:
                      key === "open" ? "realized-open" : "realized-completed",
                  },
            ),
          )
        }
      />
    </section>
  );
}

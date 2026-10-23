import { formatMoney, UNAVAILABLE } from "../../shared/money.js";
import type {
  PreviewTotals,
  ProposalPreview,
} from "../../shared/proposal-preview.js";

type CurrencyPnl = PreviewTotals["pnlByCurrency"][number];

function pnl(row: CurrencyPnl | undefined, kind: "broker" | "reconstructed") {
  if (!row) return UNAVAILABLE;
  const amount = kind === "broker" ? row.brokerPnl : row.reconstructedPnl;
  const missing =
    kind === "broker" ? row.missingBrokerPnl : row.missingReconstructedPnl;
  return (
    <>
      {formatMoney(amount, row.currency)}
      {missing > 0 && (
        <small>
          {missing} {missing === 1 ? "strategy" : "strategies"} unavailable
        </small>
      )}
    </>
  );
}

/** The preview API reports journal totals, not a single lifecycle's P/L. */
export function ConnectionImpact({
  impact,
}: {
  impact: NonNullable<ProposalPreview["impact"]>;
}) {
  const { before, after } = impact;
  const currencies = [
    ...new Set(
      [...before.pnlByCurrency, ...after.pnlByCurrency].map((r) => r.currency),
    ),
  ].sort();
  const counts = [
    ["Lifecycles", before.lifecycleCount, after.lifecycleCount],
    ["Strategies", before.strategyCount, after.strategyCount],
    [
      "Unresolved strategies",
      before.unresolvedStrategies,
      after.unresolvedStrategies,
    ],
    [
      "Journal issues",
      before.issueCounts.reduce((n, i) => n + i.count, 0),
      after.issueCounts.reduce((n, i) => n + i.count, 0),
    ],
  ] as const;
  return (
    <section className="connection-impact" aria-label="Connection preview">
      <h3>Connection preview</h3>
      <p className="muted">
        Totals across your journal. No changes are saved until you confirm.
      </p>
      <table>
        <caption className="sr-only">
          Journal totals before and after confirmation
        </caption>
        <thead>
          <tr>
            <th scope="col">Journal total</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {counts.map(([label, from, to]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{from ?? UNAVAILABLE}</td>
              <td>{to ?? UNAVAILABLE}</td>
            </tr>
          ))}
          {currencies.flatMap((currency) => {
            const from = before.pnlByCurrency.find(
              (r) => r.currency === currency,
            );
            const to = after.pnlByCurrency.find((r) => r.currency === currency);
            return (["broker", "reconstructed"] as const).map((kind) => (
              <tr key={`${currency}:${kind}`}>
                <th scope="row">
                  {kind === "broker" ? "Broker P/L" : "Reconstructed P/L"} ·{" "}
                  {currency}
                </th>
                <td>{pnl(from, kind)}</td>
                <td>{pnl(to, kind)}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </section>
  );
}

import { formatMoney } from "../../shared/money.js";
import { TransactionsEnvelope, useJson } from "../api.js";
import { ErrorPanel, Loading } from "../components.js";
import { Link } from "../navigation.js";

/** Ledger transactions with retained source references for drilldown. */
export function TransactionsPage() {
  const remote = useJson(
    "/api/transactions?pageSize=100",
    TransactionsEnvelope,
  );
  if (remote.status === "loading") {
    return <Loading label="Loading transactions…" />;
  }
  if (remote.status === "error") {
    return (
      <ErrorPanel
        message="Failed to load transactions."
        onRetry={remote.reload}
      />
    );
  }
  return (
    <section>
      <h2>Transactions</h2>
      <table aria-label="Transactions">
        <thead>
          <tr>
            <th>Date</th>
            <th>Symbol</th>
            <th>Asset class</th>
            <th>Action</th>
            <th>Event</th>
            <th>Quantity</th>
            <th>Price</th>
            <th>Currency</th>
            <th>Net cash</th>
            <th>Broker P/L</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {(remote.data?.items ?? []).map((execution) => {
            const source = execution.sources[0];
            const target =
              source === undefined
                ? null
                : `/imports?import=${source.importId}&row=${source.rowNumber}`;
            return (
              <tr key={execution.key}>
                <td>{execution.date}</td>
                <td>{execution.instrument.symbol}</td>
                <td>{execution.instrument.assetClass}</td>
                <td>{execution.action}</td>
                <td>{execution.event}</td>
                <td>{execution.quantity}</td>
                <td>
                  {execution.price === null
                    ? "—"
                    : formatMoney(execution.price, execution.currency)}
                </td>
                <td>{execution.currency}</td>
                <td>{formatMoney(execution.netCash, execution.currency)}</td>
                <td>
                  {execution.brokerPnl === null
                    ? "Unavailable"
                    : formatMoney(execution.brokerPnl, execution.currency)}
                </td>
                <td>
                  {target === null ? "—" : <Link to={target}>View source</Link>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

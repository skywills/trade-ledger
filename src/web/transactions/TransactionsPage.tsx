import { formatMoney } from "../../shared/money.js";
import { underlyingSymbol } from "../../shared/symbols.js";
import { TransactionsEnvelope, useJson } from "../api.js";
import {
  ErrorPanel,
  Loading,
  PageLinks,
  pageNumber,
  TableScroll,
} from "../components.js";
import { Link, useQuery } from "../navigation.js";

/** Ledger transactions with retained source references for drilldown. */
export function TransactionsPage() {
  const page = pageNumber(useQuery().get("page"));
  const remote = useJson(
    `/api/transactions?pageSize=100&page=${page}`,
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
      {remote.data?.items.length ? (
        <TableScroll label="Transactions table">
          <table aria-label="Transactions">
            <thead>
              <tr>
                <th>Date</th>
                <th>Symbol</th>
                <th>Underlying</th>
                <th>Asset class</th>
                <th>Action</th>
                <th>Event</th>
                <th className="ledger-number">Quantity</th>
                <th className="ledger-number">Price</th>
                <th>Currency</th>
                <th className="ledger-number">Net cash</th>
                <th className="ledger-number">Broker P/L</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {(remote.data?.items ?? []).map((execution) => {
                const source = execution.sources[0];
                const target =
                  source === undefined
                    ? null
                    : `/imports?import=${encodeURIComponent(source.importId)}&row=${source.rowNumber}`;
                return (
                  <tr key={execution.key}>
                    <td>{execution.date}</td>
                    <td>{execution.instrument.symbol}</td>
                    <td>{underlyingSymbol(execution.instrument)}</td>
                    <td>{execution.instrument.assetClass}</td>
                    <td>{execution.action}</td>
                    <td>{execution.event}</td>
                    <td className="ledger-number">{execution.quantity}</td>
                    <td className="ledger-number">
                      {execution.price === null
                        ? "—"
                        : formatMoney(execution.price, execution.currency)}
                    </td>
                    <td>{execution.currency}</td>
                    <td className="ledger-number">
                      {formatMoney(execution.netCash, execution.currency)}
                    </td>
                    <td className="ledger-number">
                      {execution.brokerPnl === null
                        ? "Unavailable"
                        : formatMoney(execution.brokerPnl, execution.currency)}
                    </td>
                    <td>
                      {target === null ? (
                        "—"
                      ) : (
                        <Link to={target}>View source</Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <p className="empty-state">
          {remote.data?.total ? (
            "No transactions on this page."
          ) : (
            <>
              No transactions yet. <Link to="/imports">Import trades</Link> to
              populate the ledger.
            </>
          )}
        </p>
      )}
      {remote.data && (
        <PageLinks {...remote.data} href={(n) => `/transactions?page=${n}`} />
      )}
    </section>
  );
}

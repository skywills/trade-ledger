import { ImportsPage } from "./imports/ImportsPage.js";
import { JournalPage } from "./journal/JournalPage.js";
import { StrategyDetail } from "./journal/StrategyDetail.js";
import { MaintenancePage } from "./maintenance/MaintenancePage.js";
import { Link, useLocation } from "./navigation.js";
import { ReviewPage } from "./review/ReviewPage.js";
import { TransactionsPage } from "./transactions/TransactionsPage.js";

function NotFound() {
  return (
    <section>
      <h2>Not found</h2>
      <p>No page matches this address.</p>
    </section>
  );
}

function renderRoute(pathname: string) {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  const second = segments[1];
  switch (first) {
    case undefined:
    case "journal":
      return <JournalPage />;
    case "imports":
      return <ImportsPage />;
    case "transactions":
      return <TransactionsPage />;
    case "review":
      return <ReviewPage />;
    case "maintenance":
      return <MaintenancePage />;
    case "strategies":
      return second === undefined ? (
        <NotFound />
      ) : (
        <StrategyDetail id={second} />
      );
    default:
      return <NotFound />;
  }
}

/** Application shell with the history-driven navigation and route switch. */
export function App() {
  const { pathname } = useLocation();
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>IBKR Trade Journal</h1>
        <nav aria-label="Primary">
          <Link to="/journal">Journal</Link>
          <Link to="/imports">Imports</Link>
          <Link to="/transactions">Transactions</Link>
          <Link to="/review">Review</Link>
          <Link to="/maintenance">Maintenance</Link>
        </nav>
      </header>
      <main className="app-main">{renderRoute(pathname)}</main>
    </div>
  );
}

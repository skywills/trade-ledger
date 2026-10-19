import { useEffect, useRef } from "react";
import { ChatPage } from "./chat/ChatPage.js";
import { DashboardPage } from "./dashboard/DashboardPage.js";
import { ImportsPage } from "./imports/ImportsPage.js";
import { JournalPage } from "./journal/JournalPage.js";
import { StrategyDetail } from "./journal/StrategyDetail.js";
import { CampaignDetail } from "./lifecycles/CampaignDetail.js";
import { LifecycleDetail } from "./lifecycles/LifecycleDetail.js";
import { LifecyclesPage } from "./lifecycles/LifecyclesPage.js";
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

/**
 * Detail routes are keyed by their id so navigating from one entity to another
 * remounts the view instead of carrying over its local form state.
 */
function renderRoute(pathname: string) {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const first = segments[0];
  let second = segments[1];
  if (
    second !== undefined &&
    ["strategies", "lifecycles", "campaigns", "chat"].includes(first ?? "")
  ) {
    try {
      second = decodeURIComponent(second);
    } catch {
      return <NotFound />;
    }
  }
  switch (first) {
    case undefined:
      return <ChatPage threadId={undefined} />;
    case "dashboard":
      return segments.length <= 2 &&
        (second === undefined ||
          second === "analysis" ||
          second === "reports") ? (
        <DashboardPage view={second ?? "overview"} />
      ) : (
        <NotFound />
      );
    case "lifecycles":
      return second ? (
        <LifecycleDetail key={second} id={second} />
      ) : (
        <LifecyclesPage />
      );
    case "campaigns":
      return second ? (
        <CampaignDetail key={second} id={second} />
      ) : (
        <NotFound />
      );
    case "journal":
      return <JournalPage />;
    case "imports":
      return <ImportsPage />;
    case "transactions":
      return <TransactionsPage />;
    case "review":
      return <ReviewPage />;
    case "chat":
      return <ChatPage threadId={second} />;
    case "maintenance":
      return <MaintenancePage />;
    case "strategies":
      return second === undefined ? (
        <NotFound />
      ) : (
        <StrategyDetail key={second} id={second} />
      );
    default:
      return <NotFound />;
  }
}

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", match: ["dashboard"] },
  { to: "/chat", label: "Agent", match: ["chat"] },
  {
    to: "/lifecycles",
    label: "Lifecycles",
    match: ["lifecycles", "campaigns"],
  },
  { to: "/journal", label: "Journal", match: ["journal", "strategies"] },
  { to: "/transactions", label: "Transactions", match: ["transactions"] },
  { to: "/imports", label: "Imports", match: ["imports"] },
  { to: "/review", label: "Review", match: ["review"] },
] as const;

/** Settings live apart from the work areas, at the far end of the bar. */
const SETTINGS_ITEM = {
  to: "/maintenance",
  label: "Maintenance",
  match: ["maintenance"],
} as const;

function NavLink({
  item,
  section,
}: {
  item: { to: string; label: string; match: readonly string[] };
  section: string;
}) {
  return (
    <Link
      to={item.to}
      aria-current={item.match.includes(section) ? "page" : undefined}
    >
      {item.label}
    </Link>
  );
}

/** Application shell with the history-driven navigation and route switch. */
export function App() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const section =
    pathname.split("/").filter((part) => part !== "")[0] ?? "chat";

  // Move focus to the main region after client-side navigation so keyboard
  // and screen-reader users land on the new page content.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <h1>TradeLedger</h1>
        <nav aria-label="Primary">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} item={item} section={section} />
          ))}
          <span className="nav-spacer" aria-hidden="true" />
          <NavLink item={SETTINGS_ITEM} section={section} />
        </nav>
      </header>
      <main id="main-content" className="app-main" ref={mainRef} tabIndex={-1}>
        {renderRoute(pathname)}
      </main>
    </div>
  );
}

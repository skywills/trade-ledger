import type { ReactNode } from "react";
import { Link } from "./navigation.js";

/** Small shared presentational primitives driven by server buildId/stale. */

export function Loading({ label, testId }: { label: string; testId?: string }) {
  return (
    <p className="loading" role="status" data-testid={testId}>
      {label}
    </p>
  );
}

export function ErrorPanel({
  message,
  onRetry,
  children,
}: {
  message: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="error-panel" role="alert">
      <p>{message}</p>
      {children}
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * Shows which retained build a view was served from. A null buildId is the
 * explicit no-active-build state; `stale` is the server's own flag, never a
 * client guess.
 */
export function BuildBadge({
  buildId,
  stale,
}: {
  buildId: string | null;
  stale: boolean;
}) {
  if (buildId === null) {
    return (
      <p className="build-badge" data-testid="build-none">
        No active build yet. <Link to="/imports">Import an IBKR Flex CSV</Link>{" "}
        to create one.
      </p>
    );
  }
  return (
    <p className="build-badge">
      <span data-testid="build-id">Build {buildId.slice(0, 8)}</span>
      {stale ? (
        <span data-testid="build-stale" role="status">
          {" "}
          · stale: inputs changed since this build
        </span>
      ) : null}
    </p>
  );
}

/** Horizontally scrollable, keyboard-focusable wrapper for wide tables. */
export function TableScroll({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
    <section className="table-scroll" aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}

/** Sign-aware class for a decimal string so gains/losses are not colour-only
 * (the formatted amount still carries its own sign). */
export function pnlClass(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) return "pnl-loss";
  return /[1-9]/.test(trimmed) ? "pnl-gain" : undefined;
}

/** URL-backed paging keeps a ledger position when returning from a detail. */
export function pageNumber(raw: string | null) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function PageLinks({
  page,
  pageSize,
  total,
  href,
}: {
  page: number;
  pageSize: number;
  total: number;
  href: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages === 1 && page === 1) return null;
  return (
    <nav className="ledger-paging" aria-label="Result pages">
      {page > 1 && <Link to={href(Math.min(page - 1, pages))}>Previous</Link>}
      <span>
        Page {page} of {pages}
      </span>
      {page < pages && <Link to={href(page + 1)}>Next</Link>}
    </nav>
  );
}

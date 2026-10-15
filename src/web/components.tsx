import type { ReactNode } from "react";

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
        No active build yet. Import a flex CSV to create one.
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

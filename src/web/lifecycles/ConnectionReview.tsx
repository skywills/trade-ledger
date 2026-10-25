import { lazy, Suspense, useState } from "react";
import type { ConnectionContext } from "./ConnectionDialog.js";
import { lifecycleLabel } from "./connections.js";
import "./connections.css";

const ConnectionDialog = lazy(() =>
  import("./ConnectionDialog.js").then((module) => ({
    default: module.ConnectionDialog,
  })),
);

export function ConnectionReview({
  context,
  disabled,
  onChanged,
}: {
  context: ConnectionContext;
  disabled: boolean;
  onChanged: (destination?: string) => void;
}) {
  const [mode, setMode] = useState<"connect" | "separate" | null>(null);
  const { group, lifecycles } = context;
  return (
    <section
      className="connection-card"
      aria-label={`${group.underlying} connection review`}
    >
      <div className="connection-card-heading">
        <span className="connection-eyebrow">CONNECTION NEEDS REVIEW</span>
        <span className="connection-count">
          {group.affectedIds.length} lifecycles
        </span>
      </div>
      <h3>Review {group.underlying} covered-call connection</h3>
      <p>
        You sold <strong>{group.contracts} calls</strong> that may belong with
        your {group.underlying} shares. Should they share one trade history and
        result?
      </p>
      <p className="muted">
        {group.instrument.symbol} · {group.currency}
      </p>
      <div className="connection-card-actions">
        <button
          type="button"
          className="primary"
          disabled={
            disabled || !group.canReviewWhole || !group.candidateIds.length
          }
          onClick={() => setMode("connect")}
        >
          Review connection
        </button>
        <button
          type="button"
          className="secondary"
          disabled={disabled || !group.canReviewWhole}
          onClick={() => setMode("separate")}
        >
          Keep trades separate
        </button>
      </div>
      {!group.canReviewWhole && (
        <p>
          Some fills already have a review decision. Use Advanced adjustments to
          review the remaining fills individually.
        </p>
      )}
      {!group.candidateIds.length && (
        <p>
          {group.suggestions.some((s) =>
            s.reasons.includes("SHARES_RESERVED_BY_OTHER_CALLS"),
          )
            ? "Still unconnected: other confirmed calls reserve the available shares at this call’s opening. Keep these trades separate, or review the existing connections."
            : "Choose individual source quantities in Advanced adjustments; these fills do not share one eligible share lifecycle."}
        </p>
      )}
      <details>
        <summary>View supporting trades</summary>
        <p>
          {
            new Set(
              group.members
                .filter((m) => m.allocation.role === "open")
                .map((m) => m.allocation.executionKey),
            ).size
          }{" "}
          opening fills · {group.shares ?? "Unknown"} shares required
        </p>
        <ul>
          {group.candidateIds.map((id) => (
            <li key={id}>
              {lifecycleLabel(lifecycles.find((l) => l.id === id))}
            </li>
          ))}
        </ul>
      </details>
      {mode && (
        <Suspense fallback={<p role="status">Loading connection review…</p>}>
          <ConnectionDialog
            context={context}
            separate={mode === "separate"}
            onDismiss={(destination, changed) => {
              setMode(null);
              if (changed) onChanged(destination);
            }}
          />
        </Suspense>
      )}
    </section>
  );
}

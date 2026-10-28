import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api.js";
import {
  type ConnectionBatch,
  type ConnectionData,
  ConnectionSelectionError,
  commonConnectionTargets,
  connectionDate,
  createConnectionBatch,
  runConnectionBatch,
} from "./connection-batch.js";
import {
  type ConnectionGroup,
  connectionTimeline,
  lifecycleLabel,
  tradeActionLabel,
} from "./connections.js";

export function BatchConnectionDialog({
  data,
  groups,
  separate,
  onDismiss,
}: {
  data: ConnectionData;
  groups: ConnectionGroup[];
  separate: boolean;
  onDismiss: () => void;
}) {
  const candidates = commonConnectionTargets(groups);
  const [target, setTarget] = useState(
    candidates.length === 1 ? (candidates[0] ?? "") : "",
  );
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [retryable, setRetryable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const batch = useRef<ConnectionBatch | null>(null);
  const inFlight = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const errorId = useId();
  const underlying = groups[0]?.underlying ?? "";
  const complete =
    batch.current?.items.filter((i) => i.status === "complete").length ?? 0;
  const saved =
    batch.current?.items.some((item) => item.receipt !== undefined) ?? false;
  const done = complete === groups.length;
  const executions = new Map(data.connectionExecutions.map((e) => [e.key, e]));
  const timeline = connectionTimeline(
    groups.flatMap((g) => g.members),
    data.connectionExecutions,
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const node = dialog.current;
    node?.showModal();
    return () => {
      controller.abort();
      node?.close();
    };
  }, []);

  function hasReceipt() {
    return (
      batch.current?.items.some((item) => item.receipt !== undefined) ?? false
    );
  }

  function dismiss() {
    if (inFlight.current && !hasReceipt()) return;
    dialog.current?.close();
    onDismiss();
  }

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setRetryable(true);
    try {
      batch.current ??= createConnectionBatch(
        data,
        groups.map((g) => g.key),
        target,
        separate,
      );
      await runConnectionBatch(
        batch.current,
        undefined,
        (message) => {
          if (!lifetime.current?.signal.aborted) setProgress(message);
        },
        lifetime.current?.signal,
      );
    } catch (e) {
      if (!lifetime.current?.signal.aborted)
        setRetryable(!(e instanceof ConnectionSelectionError));
      if (!lifetime.current?.signal.aborted)
        setError(
          e instanceof ApiError &&
            ["STALE_INPUT", "STALE_BUILD", "BUILD_CHANGED"].includes(e.code)
            ? "Your journal changed. Close this review and review the latest connections."
            : e instanceof Error
              ? e.message
              : "Unable to resolve these connections. Please retry.",
        );
    } finally {
      inFlight.current = false;
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="connection-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <div className="connection-dialog-header">
        <span className="connection-eyebrow">REVIEW SELECTED CONNECTIONS</span>
        <button
          type="button"
          className="secondary"
          disabled={busy && !saved}
          onClick={dismiss}
        >
          Close review
        </button>
      </div>
      <div className="connection-dialog-body">
        <h2 id={titleId}>
          {separate
            ? `Keep ${underlying} connections separate`
            : `Connect ${underlying} connections`}
        </h2>
        <p>
          {separate
            ? "Keep the selected calls independent of the share trades. Each trade retains its own history and results."
            : "Connect every selected call opening and close to one shared share lifecycle."}
        </p>
        <p className="muted">
          Connections are resolved oldest first. Earlier related connections
          must already be resolved or included. Shares and eligibility are
          checked again after each decision.
        </p>
        {!separate && (
          <label className="connection-target">
            Share lifecycle
            <select
              value={target}
              disabled={busy || !!batch.current}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="" disabled>
                Choose a share lifecycle
              </option>
              {candidates.map((id) => (
                <option key={id} value={id}>
                  {lifecycleLabel(
                    data.lifecycles?.lifecycles.find((l) => l.id === id),
                  )}
                </option>
              ))}
            </select>
          </label>
        )}
        <h3>Selected connections · oldest first</h3>
        <p className="muted">
          Contracts with interleaved opening fills are resolved together to
          preserve their trade history.
        </p>
        <ol className="connection-batch-items">
          {groups.map((group) => {
            const item = batch.current?.items.find(
              (i) => i.group.key === group.key,
            );
            return (
              <li key={group.key}>
                <time>{connectionDate(group, data)}</time>
                <strong>
                  {group.instrument.symbol} · {group.contracts} short calls
                </strong>
                <span>
                  {item?.status === "complete"
                    ? "Resolved"
                    : item?.status === "saved"
                      ? "Saved · journal update pending"
                      : item?.request
                        ? "Save needs confirmation"
                        : "Pending"}
                </span>
              </li>
            );
          })}
        </ol>
        <details>
          <summary>View selected supporting trades</summary>
          {timeline.uncertain && (
            <p className="muted">
              Exact trade order is uncertain for some trades. Known ordering is
              preserved.
            </p>
          )}
          <ol className="connection-timeline">
            {timeline.rows.map((member) => {
              const execution = executions.get(member.allocation.executionKey);
              return (
                <li
                  key={`${member.lifecycleId}:${JSON.stringify(member.allocation)}`}
                >
                  <time>{execution?.date ?? "Date unavailable"}</time>
                  <div>
                    <strong>
                      {tradeActionLabel(
                        execution,
                        member.quantity,
                        member.allocation.role,
                      )}
                    </strong>
                    <span>
                      {member.quantity} contracts ·{" "}
                      {execution?.instrument.symbol} · cash {member.netCash}{" "}
                      {groups[0]?.currency}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </details>
        {error && (
          <div className="connection-error" role="alert" id={errorId}>
            <p>{error}</p>
            {retryable && (
              <p>
                Completed decisions remain saved. Retry continues from the
                stopped connection without saving a decision twice.
              </p>
            )}
          </div>
        )}
        <div
          role="status"
          className={done ? "connection-outcome" : "connection-progress"}
        >
          <p>
            {complete} of {groups.length} connections resolved.
          </p>
          {busy && <p>{progress}</p>}
          {busy && saved && (
            <p>
              A decision was saved. Closing stops watching; the journal rebuild
              continues in the background.
            </p>
          )}
          {done && <p>The trade history is updated.</p>}
        </div>
      </div>
      <div className="connection-dialog-footer">
        <button
          type="button"
          className="secondary"
          disabled={busy && !saved}
          onClick={dismiss}
        >
          {done ? "Done" : "Cancel"}
        </button>
        {!done && retryable && (
          <button
            type="button"
            className="primary"
            disabled={busy || (!separate && !target)}
            aria-describedby={error ? errorId : undefined}
            onClick={() => void confirm()}
          >
            {error
              ? "Retry remaining connections"
              : separate
                ? "Confirm separate trades"
                : "Confirm connections"}
          </button>
        )}
      </div>
    </dialog>
  );
}

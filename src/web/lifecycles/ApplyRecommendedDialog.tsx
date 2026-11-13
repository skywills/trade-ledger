import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api.js";
import { applyLabel } from "./ConnectionRows.js";
import {
  applyRecommended,
  type ConnectionData,
  connectionDate,
} from "./connection-batch.js";
import { contractLabel, type PositionGroup } from "./connection-guidance.js";

export function ApplyRecommendedDialog({
  data,
  position,
  onDismiss,
}: {
  data: ConnectionData;
  position: PositionGroup;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const started = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
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

  function dismiss() {
    if (inFlight.current) return;
    dialog.current?.close();
    // Decisions may already be saved, so the list always reloads.
    onDismiss();
  }

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    started.current = true;
    setBusy(true);
    setError(null);
    try {
      await applyRecommended(
        data,
        position,
        undefined,
        (message) => {
          if (!lifetime.current?.signal.aborted) setProgress(message);
        },
        lifetime.current?.signal,
      );
      if (!lifetime.current?.signal.aborted) setDone(true);
    } catch (e) {
      if (!lifetime.current?.signal.aborted)
        setError(
          e instanceof ApiError &&
            ["STALE_INPUT", "STALE_BUILD", "BUILD_CHANGED"].includes(e.code)
            ? "Your journal changed. Close this review and review the latest connections."
            : e instanceof Error
              ? e.message
              : "Unable to apply the recommendations. Please try again.",
        );
    } finally {
      inFlight.current = false;
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  }

  const rows = [
    ...position.applicable.separate.map((g) => ({
      g,
      action: "Keep separate",
    })),
    ...position.applicable.connect.map((g) => ({ g, action: "Connect" })),
  ];
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
        <span className="connection-eyebrow">APPLY RECOMMENDED</span>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={dismiss}
        >
          Close review
        </button>
      </div>
      <div className="connection-dialog-body">
        <h2 id={titleId}>{applyLabel(position)}</h2>
        <p className="muted">{position.title}</p>
        <p className="muted">
          Calls kept separate are saved first, then the rest are connected to
          these shares. Nothing further is saved if a step fails.
        </p>
        <ol className="connection-batch-items">
          {rows.map(({ g, action }) => (
            <li key={g.key}>
              <time>{connectionDate(g, data)}</time>
              <strong>
                {contractLabel(g.instrument)} · {g.contracts} short calls
              </strong>
              <span>{action}</span>
            </li>
          ))}
        </ol>
        {error && (
          <div className="connection-error" role="alert">
            <p>{error}</p>
            {started.current && (
              <p>
                Any completed decisions remain saved. Close this review and
                review the remaining connections.
              </p>
            )}
          </div>
        )}
        <div
          role="status"
          className={done ? "connection-outcome" : "connection-progress"}
        >
          {busy && <p>{progress}</p>}
          {done && <p>The trade history is updated.</p>}
        </div>
      </div>
      <div className="connection-dialog-footer">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={dismiss}
        >
          {done || error ? "Done" : "Cancel"}
        </button>
        {!done && !error && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void confirm()}
          >
            Confirm
          </button>
        )}
      </div>
    </dialog>
  );
}

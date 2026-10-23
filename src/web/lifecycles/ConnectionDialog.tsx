import { Decimal } from "decimal.js";
import { useEffect, useId, useRef, useState } from "react";
import type { Lifecycle, LifecycleMember } from "../../shared/lifecycles.js";
import { formatMoney } from "../../shared/money.js";
import {
  type ProposalPreview,
  ProposalPreviewSchema,
} from "../../shared/proposal-preview.js";
import {
  ApiError,
  DecisionResponseSchema,
  type Execution,
  request,
  requestJson,
} from "../api.js";
import { Link } from "../navigation.js";
import { LifecycleListSchema, rebuildLifecycles } from "./api.js";
import { ConnectionImpact } from "./ConnectionImpact.js";
import {
  type ConnectionGroup,
  connectionProposal,
  connectionTimeline,
  lifecycleLabel,
  tradeActionLabel,
} from "./connections.js";
import "./connections.css";

export interface ConnectionContext {
  group: ConnectionGroup;
  lifecycles: Lifecycle[];
  members: LifecycleMember[];
  executions: Execution[];
  buildId: string;
  watermark: number;
}
export type ConnectionDraft = {
  kind: string;
  payload: Record<string, unknown>;
  rationale?: string;
  supersedesId?: string | null;
  sources?: { importId: string; rowNumber: number }[];
  strategyIds?: string[];
};
export type ConnectionReceipt = { id: string; sequence: number };

function readableError(error: unknown): string {
  if (
    error instanceof ApiError &&
    ["STALE_INPUT", "STALE_BUILD", "BUILD_CHANGED"].includes(error.code)
  )
    return "Your journal changed. Close this preview, refresh the page, and review the latest trades.";
  return error instanceof Error
    ? error.message
    : "We couldn't check this connection. Please try again.";
}

/** The same evidence and explicit confirmation are used for manual and Agent proposals. */
export function ConnectionDialog({
  context,
  separate = false,
  draft,
  accept,
  onDismiss,
}: {
  context: ConnectionContext;
  separate?: boolean;
  draft?: ConnectionDraft;
  accept?: (
    watermark: number,
    clientRequestId: string,
  ) => Promise<ConnectionReceipt>;
  onDismiss: (
    destination?: string,
    changed?: boolean,
    needsUpdate?: boolean,
  ) => void;
}) {
  const { group, lifecycles, members, executions, buildId, watermark } =
    context;
  const [target, setTarget] = useState(
    group.candidateIds.length === 1 ? (group.candidateIds[0] ?? "") : "",
  );
  const [preview, setPreview] = useState<ProposalPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [phase, setPhase] = useState<
    "preview" | "saving" | "rebuilding" | "success" | "undoing" | "undone"
  >("preview");
  const [receipt, setReceipt] = useState<ConnectionReceipt | null>(null);
  const [result, setResult] = useState<Lifecycle | null>(null);
  const [undoReceipt, setUndoReceipt] = useState<ConnectionReceipt | null>(
    null,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const mutationAttempted = useRef(false);
  const requestId = useRef({ key: "", id: crypto.randomUUID() });
  const undoId = useRef(crypto.randomUUID());
  const undoAttempted = useRef(false);
  const alive = useRef(true);
  const titleId = useId();
  const errorId = useId();
  const busy =
    phase === "saving" || phase === "rebuilding" || phase === "undoing";
  const done = phase === "success" || phase === "undone" || phase === "undoing";
  const proposal: ConnectionDraft =
    draft ?? connectionProposal(group, target, separate);
  const serialized = JSON.stringify(proposal);
  const ready = !!draft || separate || !!target;
  const exec = new Map(executions.map((e) => [e.key, e]));
  const draftTargets =
    draft?.kind === "lifecycle_attachment"
      ? ((draft.payload.targets ?? []) as { lifecycleId: string }[]).map(
          (t) => t.lifecycleId,
        )
      : draft?.kind === "lifecycle_membership"
        ? ((draft.payload.assignments ?? []) as { lifecycleId: string }[]).map(
            (a) => a.lifecycleId,
          )
        : [];
  const related = new Set(
    [
      ...group.members.map((m) => m.lifecycleId),
      ...draftTargets,
      target,
    ].filter(Boolean),
  );
  const evidence = members.filter(
    (m) => related.has(m.lifecycleId) || group.members.includes(m),
  );
  const timeline = connectionTimeline(evidence, executions);
  function dismiss() {
    if (busy) return;
    dialog.current?.close();
    onDismiss(
      phase === "success" && !separate ? (result?.id ?? target) : undefined,
      !!receipt || mutationAttempted.current,
      (phase === "preview" && mutationAttempted.current) ||
        (phase === "success" && !!error && undoAttempted.current),
    );
  }
  useEffect(() => {
    alive.current = true;
    const node = dialog.current;
    node?.showModal();
    return () => {
      alive.current = false;
      node?.close();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly starts a fresh server preview.
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setPreview(null);
    setError(null);
    void request("/api/lifecycles/connection-preview", ProposalPreviewSchema, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        proposal: JSON.parse(serialized),
        expectedBuildId: buildId,
        expectedWatermark: watermark,
      }),
    })
      .then((p) => {
        if (!controller.signal.aborted) {
          setPreview(p);
          if (!p.valid)
            setError(
              "These trades cannot be connected as selected. Check the available shares and quantities, or use Advanced adjustments.",
            );
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(readableError(e));
      });
    return () => controller.abort();
  }, [serialized, buildId, watermark, ready, retry]);

  async function finish(saved: ConnectionReceipt) {
    setPhase("rebuilding");
    await rebuildLifecycles();
    const fresh = await request("/api/lifecycles", LifecycleListSchema);
    if (!alive.current) return;
    if (fresh.stale)
      throw new Error(
        "The decision was saved, but your journal changed during the update. Retry updating the journal.",
      );
    const targetIds =
      draft?.kind === "lifecycle_attachment"
        ? ((draft.payload.targets ?? []) as { lifecycleId: string }[]).map(
            (t) => t.lifecycleId,
          )
        : draft?.kind === "lifecycle_membership"
          ? (
              (draft.payload.assignments ?? []) as { lifecycleId: string }[]
            ).map((a) => a.lifecycleId)
          : [target];
    setResult(
      fresh.lifecycles?.lifecycles.find((l) => targetIds.includes(l.id)) ??
        null,
    );
    setReceipt(saved);
    setPhase("success");
  }
  async function confirm() {
    if (inFlight.current || !preview?.valid || !ready) return;
    inFlight.current = true;
    setError(null);
    try {
      let saved = receipt;
      if (!saved) {
        if (requestId.current.key !== serialized)
          requestId.current = { key: serialized, id: crypto.randomUUID() };
        setPhase("saving");
        mutationAttempted.current = true;
        saved = accept
          ? await accept(preview.watermark, requestId.current.id)
          : (
              await requestJson(
                "/api/decisions",
                DecisionResponseSchema,
                "POST",
                {
                  clientRequestId: requestId.current.id,
                  author: "user",
                  expectedWatermark: preview.watermark,
                  kind: proposal.kind,
                  payload: proposal.payload,
                  sources: proposal.sources ?? [],
                  strategyIds: proposal.strategyIds ?? [],
                  supersedesId: proposal.supersedesId ?? null,
                },
              )
            ).decision;
        if (!alive.current) {
          await rebuildLifecycles();
          return;
        }
        setReceipt(saved);
      }
      await finish(saved);
    } catch (e) {
      if (alive.current) {
        setError(readableError(e));
        setPhase("preview");
      }
    } finally {
      inFlight.current = false;
    }
  }
  async function undo() {
    if (inFlight.current || !receipt) return;
    inFlight.current = true;
    setPhase("undoing");
    setError(null);
    try {
      if (!undoReceipt) {
        const fresh = await request("/api/lifecycles", LifecycleListSchema);
        if (
          !undoAttempted.current &&
          (fresh.stale || fresh.watermark !== receipt.sequence)
        )
          throw new Error(
            "Other changes were saved after this connection. Review decision history before undoing it.",
          );
        undoAttempted.current = true;
        const response = await requestJson(
          "/api/decisions",
          DecisionResponseSchema,
          "POST",
          {
            clientRequestId: undoId.current,
            author: "user",
            expectedWatermark: receipt.sequence,
            supersedesId: receipt.id,
            kind: "rejection",
            payload: {
              evidenceHash: `undo:${receipt.id}`,
              reason:
                "Undo call connection review; retain the original decision in history.",
            },
          },
        );
        setUndoReceipt(response.decision);
      }
      await rebuildLifecycles();
      if (alive.current) setPhase("undone");
    } catch (e) {
      if (alive.current) {
        setError(readableError(e));
        setPhase("success");
      }
    } finally {
      inFlight.current = false;
    }
  }
  return (
    <dialog
      ref={dialog}
      className="connection-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <div className="connection-dialog-header">
        <span className="connection-eyebrow">TRADE CONNECTION</span>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={dismiss}
          aria-label="Close preview"
        >
          Close
        </button>
      </div>
      <div className="connection-dialog-body">
        <h2 id={titleId}>
          {separate
            ? `Keep ${group.underlying} trades separate`
            : `Connect ${group.underlying} trades`}
        </h2>
        {done ? (
          <div className="connection-outcome" role="status">
            <h3>
              {phase === "undone"
                ? "Connection undone"
                : error && undoAttempted.current
                  ? "Finish undoing this connection"
                  : separate
                    ? "Trades kept separate"
                    : "Connection confirmed"}
            </h3>
            <p>
              {phase === "undone"
                ? "The previous review is restored. Your original decision remains in history."
                : error && undoAttempted.current
                  ? "The undo may already be saved. Retry to finish updating the journal."
                  : result?.status === "closed"
                    ? "The trade history is updated. The lifecycle is closed."
                    : "The trade history is updated. Remaining positions and review items are shown in the lifecycle."}
            </p>
          </div>
        ) : (
          <>
            <p className="muted">
              {separate
                ? "Confirm that these calls are independent of the share trade. Each trade keeps its own history and results."
                : "Review the trades below before combining their history and results into one lifecycle."}
            </p>
            <div className="connection-facts">
              <div>
                <span>Short calls</span>
                <strong>{group.contracts} contracts</strong>
                <small>{group.instrument.symbol}</small>
              </div>
              <div>
                <span>Coverage required</span>
                <strong>{group.shares ?? "Unknown"} shares</strong>
                <small>
                  {group.underlying} · {group.currency}
                </small>
              </div>
            </div>
            {!draft && !separate && (
              <label className="connection-target">
                Share lifecycle
                <select
                  value={target}
                  disabled={busy || !!receipt}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="" disabled>
                    Choose a share lifecycle
                  </option>
                  {group.candidateIds.map((id) => (
                    <option key={id} value={id}>
                      {lifecycleLabel(lifecycles.find((l) => l.id === id))}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft && (
              <section>
                <h3>Share lifecycle</h3>
                <ul>
                  {[...new Set(draftTargets)].map((id) => (
                    <li key={id}>
                      {lifecycleLabel(lifecycles.find((l) => l.id === id))}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <h3>Trade sequence</h3>
            {timeline.uncertain && (
              <p className="muted">
                Exact trade order is uncertain for some trades. Known ordering
                is preserved; other trades retain source order where possible.
              </p>
            )}
            <ol className="connection-timeline">
              {timeline.rows.map((m) => {
                const e = exec.get(m.allocation.executionKey);
                return (
                  <li
                    key={`${m.lifecycleId}:${m.allocation.strategyId}:${m.allocation.executionKey}:${m.allocation.role}`}
                  >
                    <time>{e?.date ?? "Date unavailable"}</time>
                    <div>
                      <strong>
                        {tradeActionLabel(e, m.quantity, m.allocation.role)}
                      </strong>
                      <span>
                        {new Decimal(m.quantity).abs().toString()}{" "}
                        {e?.instrument.assetClass === "STK"
                          ? "shares"
                          : "contracts"}{" "}
                        · {e?.instrument.symbol ?? "Instrument unavailable"}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            {preview?.valid && preview.impact && (
              <ConnectionImpact impact={preview.impact} />
            )}
            <section className="connection-after">
              <h3>After confirmation</h3>
              <p>
                {separate
                  ? "Keep the calls and shares in separate lifecycles and resolve this connection review."
                  : "Group every listed call opening and close with the selected share lifecycle. Existing shares stay with that lifecycle. Future fills are reviewed separately."}
              </p>
            </section>
            <details>
              <summary>Supporting trades and exact amounts</summary>
              <ul aria-label="Call source allocations to move">
                {group.members.map((m) => (
                  <li
                    key={`${m.lifecycleId}:${m.allocation.executionKey}:${m.allocation.role}`}
                  >
                    {m.allocation.role}: {m.quantity} contracts · cash{" "}
                    {m.netCash} {group.currency}
                    <br />
                    {m.allocation.executionKey}
                  </li>
                ))}
              </ul>
              <p>
                Call cash flow:{" "}
                {formatMoney(
                  group.members
                    .reduce((sum, m) => sum.plus(m.netCash), new Decimal(0))
                    .toString(),
                  group.currency,
                )}{" "}
                {group.currency}
              </p>
            </details>
          </>
        )}
        {error && (
          <div className="connection-error" id={errorId} role="alert">
            <p>
              {receipt && phase === "preview"
                ? "Your decision was saved. Retry updating the journal; it will not be saved twice. "
                : ""}
              {error}
            </p>
            {!preview && !receipt && (
              <button
                type="button"
                className="secondary"
                onClick={() => setRetry((n) => n + 1)}
              >
                Retry preview
              </button>
            )}
          </div>
        )}
        <p role="status" className="connection-progress">
          {busy
            ? phase === "saving"
              ? "Saving connection…"
              : phase === "undoing"
                ? "Undoing connection…"
                : "Updating journal…"
            : !done && ready && !preview && !error
              ? "Checking shares and trade history…"
              : !done && preview?.valid
                ? "Preview verified against the current journal."
                : ""}
        </p>
      </div>
      <div className="connection-dialog-footer">
        {done ? (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={dismiss}
            >
              Done
            </button>
            {phase === "success" && !proposal.supersedesId && (
              <button
                type="button"
                className="secondary"
                onClick={() => void undo()}
              >
                {undoAttempted.current ? "Retry undo" : "Undo connection"}
              </button>
            )}
            {phase === "success" && result && (
              <Link
                className="button"
                to={`/lifecycles/${encodeURIComponent(result.id)}`}
                onClick={() => {
                  dialog.current?.close();
                  onDismiss(result.id, true);
                }}
              >
                View lifecycle
              </Link>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={dismiss}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !preview?.valid || !ready}
              aria-describedby={error ? errorId : undefined}
              onClick={() => void confirm()}
            >
              {receipt
                ? "Retry journal update"
                : separate
                  ? "Confirm separate trades"
                  : "Confirm connection"}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}

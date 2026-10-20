import { Decimal } from "decimal.js";
import { useEffect, useRef, useState } from "react";
import type {
  AllocationRef,
  LifecycleMember,
} from "../../shared/lifecycles.js";
import { formatMoney } from "../../shared/money.js";
import { useJobSignal, useJson } from "../api.js";
import { BuildBadge, ErrorPanel, Loading, TableScroll } from "../components.js";
import { Link, navigate, useLocation } from "../navigation.js";
import {
  LifecycleDetailSchema,
  LifecycleListSchema,
  rebuildLifecycles,
  recordLifecycleDecision,
  type SaveDecision,
} from "./api.js";
import { BuildAction } from "./BuildAction.js";
import { ConnectionReview } from "./ConnectionReview.js";
import { connectionGroups, reviewLabel } from "./connections.js";
import { MembershipEditor, SourcePartitionEditor } from "./MembershipEditor.js";
import { ValuationEditor } from "./ValuationEditor.js";
import "./lifecycles.css";

function sourceCash(
  members: LifecycleMember[],
  allocation: AllocationRef,
): string | null {
  const matching = members.filter(
    (m) =>
      m.allocation.strategyId === allocation.strategyId &&
      m.allocation.executionKey === allocation.executionKey &&
      m.allocation.role === allocation.role,
  );
  return matching.length
    ? matching
        .reduce((sum, m) => sum.plus(m.netCash), new Decimal(0))
        .toString()
    : null;
}
export function LifecycleDetail({ id }: { id: string }) {
  const jobSignal = useJobSignal(id);
  const { search } = useLocation();
  const expected = new URLSearchParams(search).get("expectedBuildId");
  const path = `/api/lifecycles/${encodeURIComponent(id)}${expected ? `?expectedBuildId=${encodeURIComponent(expected)}` : ""}`;
  const remote = useJson(path, LifecycleDetailSchema);
  const all = useJson("/api/lifecycles", LifecycleListSchema);
  const [busy, setBusy] = useState(false);
  const [supersedesId, setSupersedesId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  // Set once a decision is recorded and cleared when its rebuild completes, so
  // a retry after a failed rebuild only rebuilds.
  const [rebuildPending, setRebuildPending] = useState(false);
  // Synchronous double-submit guard; `busy` only disables after a re-render.
  const inFlight = useRef(false);
  // One clientRequestId per decision, reused if the same decision is retried.
  const pendingRequest = useRef<{ key: string; id: string } | null>(null);
  function refresh() {
    navigate(`/lifecycles/${encodeURIComponent(id)}`);
    remote.reload();
    all.reload();
  }
  function onBuilt() {
    setRebuildPending(false);
    refresh();
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset operation state when navigating to another lifecycle.
  useEffect(() => {
    inFlight.current = false;
    setBusy(false);
    setError(null);
    setNotice(null);
    setRebuildPending(false);
  }, [id]);
  async function run(task: (signal: AbortSignal) => Promise<void>) {
    const signal = jobSignal();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await task(signal);
      signal.throwIfAborted();
      setNotice("Decision saved and journal rebuilt.");
      refresh();
    } catch (e) {
      if (signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
      remote.reload();
      all.reload();
    } finally {
      if (!signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function rebuild(signal: AbortSignal) {
    await rebuildLifecycles(signal);
    signal.throwIfAborted();
    setRebuildPending(false);
  }
  const save: SaveDecision = async (kind, payload) => {
    const data = remote.data;
    if (!data || rebuildPending) return;
    const supersedes = supersedesId.trim() || null;
    const key = JSON.stringify([kind, payload, supersedes]);
    if (pendingRequest.current?.key !== key)
      pendingRequest.current = { key, id: crypto.randomUUID() };
    const clientRequestId = pendingRequest.current.id;
    await run(async (signal) => {
      await recordLifecycleDecision(
        data.watermark,
        kind,
        payload,
        supersedes,
        clientRequestId,
      );
      if (!signal.aborted) {
        pendingRequest.current = null;
        setSupersedesId("");
        setRebuildPending(true);
      }
      await rebuild(signal);
    });
  };
  if (remote.status === "loading")
    return <Loading label="Loading lifecycle…" />;
  if (!remote.data)
    return (
      <ErrorPanel
        message={remote.error?.message ?? "Unable to load lifecycle."}
        onRetry={refresh}
      >
        <Link to="/lifecycles">Back to lifecycles</Link>
        {remote.error?.code === "LIFECYCLE_REBUILD_REQUIRED" && (
          <BuildAction onBuilt={onBuilt} />
        )}
      </ErrorPanel>
    );
  const d = remote.data;
  const l = d.lifecycle;
  const projection =
    all.data?.buildId === d.buildId ? all.data.lifecycles : null;
  const eligibleCampaigns = d.campaigns.filter(
    (c) =>
      c.account === l.account &&
      c.currency === l.currency &&
      c.underlyingKey === l.underlyingKey,
  );
  const disabled = busy || rebuildPending || d.stale || d.rebuildRequired;
  return (
    <section className="lifecycles">
      <p>
        <Link to="/lifecycles">← Lifecycles</Link>
      </p>
      <h2>{l.description || l.id}</h2>
      <BuildBadge buildId={d.buildId} stale={d.stale} />
      {(d.stale || d.rebuildRequired) && (
        <div className="error-panel">
          <p>Rebuild the journal before changing this lifecycle.</p>
          <BuildAction onBuilt={onBuilt} />
        </div>
      )}
      {busy && <Loading label="Saving decision and rebuilding journal…" />}
      {error &&
        (rebuildPending ? (
          <ErrorPanel
            message={`The decision was saved, but the rebuild failed: ${error}`}
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(rebuild)}
            >
              Retry rebuild
            </button>
          </ErrorPanel>
        ) : (
          <ErrorPanel message={error} onRetry={refresh} />
        ))}
      <p role="status">{notice}</p>
      {projection &&
        d.buildId &&
        connectionGroups(
          projection.suggestions,
          projection.members,
          all.data?.connectionExecutions.length
            ? all.data.connectionExecutions
            : d.executions,
        )
          .filter((group) => group.affectedIds.includes(id))
          .map((group) => (
            <ConnectionReview
              key={`${group.key}:${d.buildId}`}
              disabled={disabled}
              context={{
                group,
                lifecycles: projection.lifecycles,
                members: projection.members,
                executions: all.data?.connectionExecutions.length
                  ? all.data.connectionExecutions
                  : d.executions,
                buildId: d.buildId ?? "",
                watermark: d.watermark,
              }}
              onChanged={(destination) => {
                if (destination && destination !== id)
                  navigate(`/lifecycles/${encodeURIComponent(destination)}`);
                else refresh();
              }}
            />
          ))}
      <div className="card-grid">
        <section className="card">
          <h3>Lifecycle holdings</h3>
          <dl>
            <dt>Account</dt>
            <dd>{l.account}</dd>
            <dt>Origin strategy</dt>
            <dd>{l.originStrategyType}</dd>
            <dt>Stage</dt>
            <dd>{l.stage.replaceAll("_", " ")}</dd>
            <dt>Position</dt>
            <dd>{l.positions.length ? "Open" : "Closed"}</dd>
            <dt>Review</dt>
            <dd>
              {l.reasons.includes("PENDING_CALL_ATTACHMENT")
                ? "Connection pending"
                : l.status === "unresolved"
                  ? "Needs review"
                  : "Complete"}
            </dd>
            <dt>Covered shares</dt>
            <dd>{l.coveredShares}</dd>
            <dt>Uncovered shares</dt>
            <dd>{l.uncoveredShares}</dd>
            <dt>Completed</dt>
            <dd>{l.status === "closed" && l.complete ? "Yes" : "No"}</dd>
          </dl>
          <ul aria-label="Remaining holdings">
            {l.positions.map((p) => (
              <li key={p.instrumentKey}>
                {d.executions.find((e) => e.instrument.key === p.instrumentKey)
                  ?.instrument.symbol ?? p.instrumentKey}
                : {p.quantity}
              </li>
            ))}
          </ul>
          {l.reasons.length > 0 && <p>{reviewLabel(l.reasons)}</p>}
        </section>
        <section className="card">
          <h3>Cash and results · {l.currency}</h3>
          <dl>
            <dt>Lifecycle cashflow</dt>
            <dd>{formatMoney(l.cashflow, l.currency)}</dd>
            <dt>Broker realized P&amp;L</dt>
            <dd>
              {formatMoney(
                l.status === "closed"
                  ? l.brokerPnl
                  : (d.valuation?.realizedBrokerPnl ?? null),
                l.currency,
              )}
            </dd>
            <dt>Completed reconstructed P&amp;L</dt>
            <dd>{formatMoney(l.reconstructedPnl, l.currency)}</dd>
            {l.status !== "closed" && (
              <>
                <dt>Open total P&amp;L</dt>
                <dd>
                  {formatMoney(d.valuation?.totalPnl ?? null, l.currency)}
                </dd>
                <dt>Residual unrealized P&amp;L</dt>
                <dd>
                  {formatMoney(d.valuation?.unrealizedPnl ?? null, l.currency)}
                </dd>
                <dt>Price snapshot</dt>
                <dd>
                  {d.valuation?.asOf ?? "No complete dated prices"}
                  {d.valuation?.source ? ` · ${d.valuation.source}` : ""}
                </dd>
              </>
            )}
          </dl>
          {d.valuation?.reasons.map((reason) => (
            <p key={reason}>{reason.replaceAll("_", " ")}</p>
          ))}
        </section>
      </div>
      <h3>Full event timeline</h3>
      <p>Cash below is the portion belonging to this lifecycle.</p>
      <TableScroll label="Lifecycle timeline">
        <table aria-label="Lifecycle timeline">
          <thead>
            <tr>
              <th>Date</th>
              <th>Instrument</th>
              <th>Event</th>
              <th>Role</th>
              <th>Quantity</th>
              <th>Net cash</th>
              <th>Component</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {[...d.members]
              .sort((a, b) =>
                (
                  d.executions.find((e) => e.key === a.allocation.executionKey)
                    ?.date ?? ""
                ).localeCompare(
                  d.executions.find((e) => e.key === b.allocation.executionKey)
                    ?.date ?? "",
                ),
              )
              .map((m) => {
                const e = d.executions.find(
                  (e) => e.key === m.allocation.executionKey,
                );
                return (
                  <tr
                    key={`${m.allocation.strategyId}-${m.allocation.executionKey}-${m.allocation.role}`}
                  >
                    <td>{e?.date ?? "Unknown"}</td>
                    <td>{e?.instrument.symbol ?? m.allocation.executionKey}</td>
                    <td>{e?.event.replaceAll("_", " ") ?? "Unknown"}</td>
                    <td>{m.allocation.role}</td>
                    <td>{m.quantity}</td>
                    <td>{formatMoney(m.netCash, l.currency)}</td>
                    <td>
                      <Link
                        to={`/strategies/${encodeURIComponent(m.allocation.strategyId)}`}
                      >
                        Original component
                      </Link>
                    </td>
                    <td>
                      {m.sources.map((s) => (
                        <span key={`${s.importId}-${s.rowNumber}`}>
                          <Link
                            to={`/imports?import=${encodeURIComponent(s.importId)}&row=${s.rowNumber}`}
                          >
                            Row {s.rowNumber}
                          </Link>{" "}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </TableScroll>
      <h3>Original components and notes</h3>
      <p>Notes remain with their original components.</p>
      <ul>
        {l.componentIds.map((componentId) => (
          <li key={componentId}>
            <Link to={`/strategies/${encodeURIComponent(componentId)}`}>
              {componentId}
            </Link>
          </li>
        ))}
      </ul>
      <details className="advanced-adjustments">
        <summary>Advanced adjustments</summary>
        <p>
          Split individual fills, correct source quantities, or replace a
          retained decision.
        </p>
        <details>
          <summary>Correct a retained decision</summary>
          <label>
            Superseded decision ID (optional)
            <input
              disabled={disabled}
              value={supersedesId}
              onChange={(e) => setSupersedesId(e.target.value)}
            />
          </label>
          <p>Enter the earlier decision ID before saving its replacement.</p>
        </details>
        {d.suggestions.map((s) => (
          <MembershipEditor
            key={`${s.id}:${d.buildId}:${projection !== null}`}
            suggestion={s}
            executions={d.executions}
            openingCash={
              projection ? sourceCash(projection.members, s.callOpening) : null
            }
            callMembers={
              projection?.members.filter(
                (m) =>
                  m.allocation.strategyId === s.callOpening.strategyId &&
                  d.executions.find((e) => e.key === m.allocation.executionKey)
                    ?.instrument.key ===
                    d.executions.find(
                      (e) => e.key === s.callOpening.executionKey,
                    )?.instrument.key,
              ) ?? []
            }
            candidates={s.candidateLifecycleIds}
            save={save}
            disabled={disabled || !projection}
          />
        ))}
        {projection && (
          <SourcePartitionEditor
            key={d.buildId}
            members={projection.members.filter((m) =>
              projection.lifecycles.some(
                (x) =>
                  x.id === m.lifecycleId &&
                  x.account === l.account &&
                  x.currency === l.currency &&
                  x.underlyingKey === l.underlyingKey,
              ),
            )}
            candidates={projection.lifecycles
              .filter(
                (x) =>
                  x.account === l.account &&
                  x.currency === l.currency &&
                  x.underlyingKey === l.underlyingKey,
              )
              .map((x) => x.id)}
            save={save}
            disabled={disabled}
          />
        )}
      </details>
      <h3>Wheel campaign</h3>
      {l.campaignId && (
        <p>
          <Link
            to={`/campaigns/${encodeURIComponent(l.campaignId)}?expectedBuildId=${encodeURIComponent(d.buildId ?? "")}`}
          >
            View campaign
          </Link>
        </p>
      )}
      <fieldset disabled={disabled}>
        <legend>Group independent cycles</legend>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("wheel_campaign_membership", {
              lifecycleId: l.id,
              campaignId: (campaignId ?? l.campaignId) || null,
            });
          }}
        >
          <label>
            Campaign
            <select
              aria-label="Campaign"
              value={campaignId ?? l.campaignId ?? ""}
              onChange={(e) => setCampaignId(e.target.value)}
            >
              <option value="">No campaign</option>
              {eligibleCampaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Save campaign membership and rebuild</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save("wheel_campaign", {
              campaignId: crypto.randomUUID(),
              name: name.trim(),
              account: l.account,
              currency: l.currency,
              underlyingKey: l.underlyingKey,
            });
          }}
        >
          <label>
            New campaign name
            <input
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button type="submit" disabled={!name.trim()}>
            Create campaign and rebuild
          </button>
        </form>
        <p>Create a campaign, then select it above to attach this cycle.</p>
      </fieldset>
      <ValuationEditor
        key={d.buildId}
        lifecycle={l}
        executions={d.executions}
        save={save}
        disabled={disabled}
      />
    </section>
  );
}

import { Decimal } from "decimal.js";
import { useState } from "react";
import { splitAmount } from "../../server/strategies/allocation.js";
import type {
  AllocationRef,
  AttachmentSuggestion,
  LifecycleMember,
} from "../../shared/lifecycles.js";
import type { Execution } from "../api.js";
import { Link } from "../navigation.js";
import type { SaveDecision } from "./api.js";

function callCashForTarget(
  members: LifecycleMember[],
  targets: { lifecycleId: string; quantity: string }[],
  lifecycleId: string,
): string {
  const sourceAmounts = new Map<string, Decimal>();
  for (const member of members) {
    const key = JSON.stringify(member.allocation);
    sourceAmounts.set(
      key,
      (sourceAmounts.get(key) ?? new Decimal(0)).plus(member.netCash),
    );
  }
  return [...sourceAmounts.values()]
    .reduce(
      (sum, amount) =>
        sum.plus(
          splitAmount(
            amount.toString(),
            targets.map((t) => ({
              strategyId: t.lifecycleId,
              quantity: t.quantity,
            })),
          ).find((part) => part.strategyId === lifecycleId)?.amount ?? "0",
        ),
      new Decimal(0),
    )
    .toString();
}
/** A close follows a split only when every resulting contract count is whole. */
function attachmentPreview(
  members: LifecycleMember[],
  targets: { lifecycleId: string; quantity: string }[],
  openingQuantity: string,
) {
  const groups = new Map<string, LifecycleMember[]>();
  for (const member of members) {
    const key = JSON.stringify([
      member.allocation.strategyId,
      member.allocation.executionKey,
      member.allocation.role,
    ]);
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  const moving: LifecycleMember[] = [];
  const pending: { executionKey: string; quantity: string; netCash: string }[] =
    [];
  const opening = new Decimal(openingQuantity).abs();
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const quantity = group.reduce(
      (sum, member) => sum.plus(member.quantity),
      new Decimal(0),
    );
    if (
      first.allocation.role === "close" &&
      targets.some(
        (target) => !quantity.times(target.quantity).div(opening).isInteger(),
      )
    ) {
      pending.push({
        executionKey: first.allocation.executionKey,
        quantity: quantity.abs().toString(),
        netCash: group
          .reduce((sum, member) => sum.plus(member.netCash), new Decimal(0))
          .toString(),
      });
    } else moving.push(...group);
  }
  return { moving, pending };
}
/** Every edit is previewed with its source quantity and cash before append. */
export function MembershipEditor({
  suggestion,
  executions,
  openingCash,
  callMembers,
  candidates,
  save,
  disabled,
}: {
  suggestion: AttachmentSuggestion;
  executions: Execution[];
  openingCash: string | null;
  callMembers: LifecycleMember[];
  candidates: string[];
  save: SaveDecision;
  disabled: boolean;
}) {
  const [targets, setTargets] = useState([
    {
      key: crypto.randomUUID(),
      lifecycleId: suggestion.candidateLifecycleIds[0] ?? "",
      quantity: new Decimal(suggestion.quantity).abs().toString(),
    },
  ]);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execution = executions.find(
    (e) => e.key === suggestion.callOpening.executionKey,
  );
  function validate() {
    try {
      if (openingCash === null)
        throw new Error("Wait for source cash to load, then preview again.");
      if (new Set(targets.map((t) => t.lifecycleId)).size !== targets.length)
        throw new Error("Choose a different lifecycle for each part.");
      const sum = targets.reduce((n, t) => {
        const q = new Decimal(t.quantity);
        if (!q.isInteger() || q.lte(0) || !t.lifecycleId)
          throw new Error(
            "Choose a lifecycle and enter a positive whole number of contracts for each part.",
          );
        return n.plus(q);
      }, new Decimal(0));
      if (!sum.eq(new Decimal(suggestion.quantity).abs()))
        throw new Error(
          `Allocate all ${suggestion.quantity} contracts exactly once.`,
        );
      setError(null);
      setPreview(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enter valid quantities.");
    }
  }
  const planned = preview
    ? attachmentPreview(callMembers, targets, suggestion.quantity)
    : { moving: [], pending: [] };
  return (
    <fieldset disabled={disabled}>
      <legend>Covered-call attachment</legend>
      <p>
        Call:{" "}
        <Link
          to={`/strategies/${encodeURIComponent(suggestion.callOpening.strategyId)}`}
        >
          {execution?.instrument.symbol ?? suggestion.callOpening.executionKey}
        </Link>{" "}
        · {suggestion.quantity} contracts
      </p>
      <p>{suggestion.reasons.join(" · ")}</p>
      {targets.map((target, index) => (
        <div className="lifecycle-partition" key={target.key}>
          <label>
            Target lifecycle {index + 1}
            <select
              value={target.lifecycleId}
              onChange={(e) => {
                setPreview(false);
                setTargets(
                  targets.map((t, i) =>
                    i === index ? { ...t, lifecycleId: e.target.value } : t,
                  ),
                );
              }}
            >
              {candidates.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Contracts {index + 1}
            <input
              inputMode="numeric"
              value={target.quantity}
              onChange={(e) => {
                setPreview(false);
                setTargets(
                  targets.map((t, i) =>
                    i === index ? { ...t, quantity: e.target.value } : t,
                  ),
                );
              }}
            />
          </label>
          {targets.length > 1 && (
            <button
              type="button"
              onClick={() => {
                setPreview(false);
                setTargets(targets.filter((_, i) => i !== index));
              }}
            >
              Remove part {index + 1}
            </button>
          )}
        </div>
      ))}
      <div className="lifecycle-actions">
        <button
          type="button"
          onClick={() => {
            setPreview(false);
            setTargets([
              ...targets,
              {
                key: crypto.randomUUID(),
                lifecycleId: candidates[0] ?? "",
                quantity: "1",
              },
            ]);
          }}
        >
          Split contracts
        </button>
        <button type="button" onClick={validate}>
          Preview attachment
        </button>
      </div>
      {preview && (
        <div className="lifecycle-status">
          <h4>Attachment preview</h4>
          <p>
            The selected call opening moves with closes that can be assigned as
            whole contracts. Future closes follow the same rule. Stock remains
            in its existing lifecycle.
          </p>
          {planned.pending.length > 0 && (
            <aside aria-label="Closes requiring quantity review">
              <h4>Closing contracts need review</h4>
              <p>
                These closes remain in their original lifecycle until you assign
                their whole contracts using Correct source membership. Their
                cash is excluded from this preview.
              </p>
              <ul>
                {planned.pending.map((close) => (
                  <li key={close.executionKey}>
                    {close.executionKey} · {close.quantity} contracts · cash{" "}
                    {close.netCash} {execution?.currency}
                  </li>
                ))}
              </ul>
            </aside>
          )}
          <ul aria-label="Call source allocations to move">
            {planned.moving.map((m) => (
              <li
                key={`${m.lifecycleId}-${m.allocation.executionKey}-${m.allocation.role}`}
              >
                {m.allocation.role}: {m.quantity} contracts · cash {m.netCash}{" "}
                {execution?.currency} · {m.allocation.executionKey}
              </li>
            ))}
          </ul>
          <ul>
            {targets.map((t) => {
              const q = new Decimal(t.quantity);
              const shares = execution?.instrument.multiplier
                ? q.times(execution.instrument.multiplier).toString()
                : null;
              const cash =
                openingCash === null
                  ? null
                  : (splitAmount(
                      openingCash,
                      targets.map((target) => ({
                        strategyId: target.lifecycleId,
                        quantity: target.quantity,
                      })),
                    ).find((part) => part.strategyId === t.lifecycleId)
                      ?.amount ?? null);
              return (
                <li key={t.key}>
                  {t.lifecycleId}: {t.quantity} contracts ·{" "}
                  {shares ?? "Unknown"} shares reserved · opening cash{" "}
                  {cash ?? "Unavailable"} {execution?.currency} · cash moving
                  now{" "}
                  {callCashForTarget(planned.moving, targets, t.lifecycleId)}{" "}
                  {execution?.currency}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() =>
              void save("lifecycle_attachment", {
                opening: suggestion.callOpening,
                targets: targets.map(({ lifecycleId, quantity }) => ({
                  lifecycleId,
                  quantity: new Decimal(quantity)
                    .abs()
                    .times(
                      new Decimal(suggestion.quantity).isNegative() ? -1 : 1,
                    )
                    .toString(),
                })),
              })
            }
          >
            Accept attachment and rebuild
          </button>
        </div>
      )}
      <label>
        Reason to keep call independent
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button
        type="button"
        disabled={!reason.trim()}
        onClick={() =>
          void save("lifecycle_attachment_rejection", {
            callOpening: suggestion.callOpening,
            candidateLifecycleIds: suggestion.candidateLifecycleIds,
            reason: reason.trim(),
          })
        }
      >
        Reject attachment and rebuild
      </button>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}

/** Edits one complete source partition, preserving all other source allocations. */
export function SourcePartitionEditor({
  members,
  candidates,
  save,
  disabled,
}: {
  members: LifecycleMember[];
  candidates: string[];
  save: SaveDecision;
  disabled: boolean;
}) {
  const [selected, setSelected] = useState("0");
  const source = members[Number(selected)];
  const [parts, setParts] = useState(() =>
    members
      .filter(
        (m) =>
          source &&
          m.allocation.strategyId === source.allocation.strategyId &&
          m.allocation.executionKey === source.allocation.executionKey &&
          m.allocation.role === source.allocation.role,
      )
      .map((m) => ({
        key: crypto.randomUUID(),
        lifecycleId: m.lifecycleId,
        quantity: new Decimal(m.quantity).abs().toString(),
      })),
  );
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!source) return null;
  const same = (a: AllocationRef, b: AllocationRef) =>
    a.strategyId === b.strategyId &&
    a.executionKey === b.executionKey &&
    a.role === b.role;
  const current = members.filter((m) => same(m.allocation, source.allocation));
  const signedTotal = current.reduce(
    (n, m) => n.plus(m.quantity),
    new Decimal(0),
  );
  const total = signedTotal.abs();
  return (
    <details>
      <summary>Correct source membership</summary>
      <fieldset disabled={disabled}>
        <legend>Complete source partition</legend>
        <label>
          Source allocation
          <select
            value={selected}
            onChange={(e) => {
              const m = members[Number(e.target.value)];
              setSelected(e.target.value);
              setParts(
                m
                  ? members
                      .filter((x) => same(x.allocation, m.allocation))
                      .map((x) => ({
                        key: crypto.randomUUID(),
                        lifecycleId: x.lifecycleId,
                        quantity: new Decimal(x.quantity).abs().toString(),
                      }))
                  : [],
              );
              setPreview(false);
            }}
          >
            {members.map((m, i) => (
              <option
                key={`${m.lifecycleId}-${m.allocation.strategyId}-${m.allocation.executionKey}-${m.allocation.role}`}
                value={i}
              >
                {m.allocation.executionKey} · {m.allocation.role}
              </option>
            ))}
          </select>
        </label>
        <p>
          Allocate all {total.toString()} units. Cash and broker P&amp;L follow
          the same proportions.
        </p>
        {parts.map((part, index) => (
          <div className="lifecycle-partition" key={part.key}>
            <label>
              Lifecycle {index + 1}
              <select
                aria-label={`Lifecycle ${index + 1}`}
                value={part.lifecycleId}
                onChange={(e) => {
                  setPreview(false);
                  setParts(
                    parts.map((p, i) =>
                      i === index ? { ...p, lifecycleId: e.target.value } : p,
                    ),
                  );
                }}
              >
                {candidates.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
            <label>
              Quantity {index + 1}
              <input
                value={part.quantity}
                onChange={(e) => {
                  setPreview(false);
                  setParts(
                    parts.map((p, i) =>
                      i === index ? { ...p, quantity: e.target.value } : p,
                    ),
                  );
                }}
              />
            </label>
            <button
              type="button"
              disabled={parts.length === 1}
              onClick={() => {
                setPreview(false);
                setParts(parts.filter((_, i) => i !== index));
              }}
            >
              Remove allocation {index + 1}
            </button>
          </div>
        ))}
        <div className="lifecycle-actions">
          <button
            type="button"
            onClick={() => {
              setPreview(false);
              setParts([
                ...parts,
                {
                  key: crypto.randomUUID(),
                  lifecycleId: candidates[0] ?? "",
                  quantity: "",
                },
              ]);
            }}
          >
            Add allocation
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                if (
                  new Set(parts.map((p) => p.lifecycleId)).size !== parts.length
                )
                  throw new Error(
                    "Choose a different lifecycle for each allocation.",
                  );
                const sum = parts.reduce((n, p) => {
                  const q = new Decimal(p.quantity);
                  if (q.lte(0)) throw new Error("Quantities must be positive.");
                  return n.plus(q);
                }, new Decimal(0));
                if (!sum.eq(total))
                  throw new Error(
                    "The quantities must equal the complete source quantity.",
                  );
                setError(null);
                setPreview(true);
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Enter valid quantities.",
                );
              }
            }}
          >
            Preview membership
          </button>
        </div>
        {preview && (
          <>
            <ul>
              {parts.map((p) => (
                <li key={p.key}>
                  {p.lifecycleId}: {p.quantity} units; cash{" "}
                  {splitAmount(
                    current
                      .reduce((n, m) => n.plus(m.netCash), new Decimal(0))
                      .toString(),
                    parts.map((part) => ({
                      strategyId: part.lifecycleId,
                      quantity: part.quantity,
                    })),
                  ).find((part) => part.strategyId === p.lifecycleId)?.amount ??
                    "Unavailable"}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() =>
                void save("lifecycle_membership", {
                  assignments: parts.map(({ lifecycleId, quantity }) => ({
                    lifecycleId,
                    quantity: new Decimal(quantity)
                      .times(signedTotal.isNegative() ? -1 : 1)
                      .toString(),
                    allocation: source.allocation,
                  })),
                })
              }
            >
              Save membership and rebuild
            </button>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </details>
  );
}

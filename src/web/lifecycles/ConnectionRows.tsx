import { Link } from "../navigation.js";
import { type ConnectionData, connectionDate } from "./connection-batch.js";
import {
  contractLabel,
  explainPlan,
  groupPlan,
  type PositionGroup,
  shortCallsLabel,
} from "./connection-guidance.js";
import { type ConnectionGroup, lifecycleLabel } from "./connections.js";

const BADGES = {
  connect: "Connect",
  separate: "Keep separate",
  manual: "Needs your choice",
} as const;

export function ConnectionRow({
  group,
  data,
  checked,
  disabled,
  onToggle,
}: {
  group: ConnectionGroup;
  data: ConnectionData;
  checked: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const owner = group.members[0]?.lifecycleId ?? group.candidateIds[0];
  const plan = groupPlan(group);
  return (
    <li>
      <label className="connection-selection">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || !group.canReviewWhole}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>
          <time>{connectionDate(group, data)}</time>
          <strong>
            {contractLabel(group.instrument)} ·{" "}
            {shortCallsLabel(group.contracts)}
          </strong>
        </span>
      </label>
      {plan && (
        <>
          <span className={`connection-badge connection-badge-${plan.action}`}>
            {BADGES[plan.action]}
          </span>
          <p className="muted">{explainPlan(plan, data, group)}</p>
        </>
      )}
      <p className="muted">
        {group.candidateIds
          .map((id) =>
            lifecycleLabel(
              data.lifecycles?.lifecycles.find((l) => l.id === id),
            ),
          )
          .join(" / ")}
      </p>
      {!plan &&
        group.suggestions.some((s) =>
          s.reasons.includes("SHARES_RESERVED_BY_OTHER_CALLS"),
        ) && (
          <p className="muted">
            Still unconnected: other confirmed calls reserve the available
            shares at this call’s opening. Keep these trades separate, or review
            the existing connections.
          </p>
        )}
      {!group.canReviewWhole && (
        <p className="muted">
          Some fills already have a decision. Use individual review for the
          remaining fills.
        </p>
      )}
      {owner && (
        <Link
          to={`/lifecycles/${encodeURIComponent(owner)}?expectedBuildId=${encodeURIComponent(data.buildId ?? "")}`}
        >
          Review connection
        </Link>
      )}
    </li>
  );
}

export function applyLabel(position: PositionGroup): string {
  const { connect, separate } = position.applicable;
  const clauses = [
    connect.length ? `connect ${connect.length}` : "",
    separate.length ? `keep ${separate.length} separate` : "",
  ].filter(Boolean);
  return `Apply recommended: ${clauses.join(", ")}`;
}

export function ApplyRecommendedButton({
  position,
  data,
  disabled,
  onApply,
}: {
  position: PositionGroup;
  data: ConnectionData;
  disabled: boolean;
  onApply: () => void;
}) {
  const { connect, separate } = position.applicable;
  if (position.lifecycleId === null || !(connect.length + separate.length))
    return null;
  const blocker = position.blockedBy;
  return (
    <div className="connection-apply">
      <button
        type="button"
        className="primary"
        disabled={disabled || !!blocker}
        onClick={onApply}
      >
        {applyLabel(position)}
      </button>
      {blocker && (
        <p className="muted">
          Resolve the {connectionDate(blocker, data)}{" "}
          {contractLabel(blocker.instrument)} call first.
        </p>
      )}
    </div>
  );
}

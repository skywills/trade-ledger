import { lazy, Suspense, useState } from "react";
import { Link } from "../navigation.js";
import {
  type ConnectionData,
  type ConnectionSection,
  commonConnectionTargets,
  connectionDate,
  connectionSections,
} from "./connection-batch.js";
import { lifecycleLabel } from "./connections.js";
import "./connections.css";

const BatchConnectionDialog = lazy(() =>
  import("./BatchConnectionDialog.js").then((m) => ({
    default: m.BatchConnectionDialog,
  })),
);

function UnderlyingConnections({
  section,
  data,
  onChanged,
}: {
  section: ConnectionSection;
  data: ConnectionData;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"connect" | "separate" | null>(null);
  const eligible = section.groups.filter((g) => g.canReviewWhole);
  const groups = section.groups.filter((g) => selected.has(g.key));
  const allSelected =
    eligible.length > 0 && eligible.every((g) => selected.has(g.key));
  const disabled = data.stale || data.rebuildRequired || !data.buildId;
  const candidates = commonConnectionTargets(groups);
  return (
    <section
      className="connection-underlying"
      aria-label={`${section.underlying} connection reviews`}
    >
      <h4>
        {section.underlying}{" "}
        <span className="connection-count">
          {section.groups.length} connections
        </span>
      </h4>
      <p className="muted">
        Account {section.account} · {section.currency} · oldest first
      </p>
      <label className="connection-selection">
        <input
          type="checkbox"
          checked={allSelected}
          disabled={disabled || !eligible.length}
          onChange={(e) =>
            setSelected(
              new Set(e.target.checked ? eligible.map((g) => g.key) : []),
            )
          }
        />
        Select all {section.underlying} connections
      </label>
      <ul className="connection-selection-list">
        {section.groups.map((group) => {
          const owner = group.members[0]?.lifecycleId ?? group.candidateIds[0];
          return (
            <li key={group.key}>
              <label className="connection-selection">
                <input
                  type="checkbox"
                  checked={selected.has(group.key)}
                  disabled={disabled || !group.canReviewWhole}
                  onChange={(e) =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (e.target.checked) next.add(group.key);
                      else next.delete(group.key);
                      return next;
                    })
                  }
                />
                <span>
                  <time>{connectionDate(group, data)}</time>
                  <strong>
                    {group.instrument.symbol} · {group.contracts} short calls
                  </strong>
                </span>
              </label>
              <p className="muted">
                {group.candidateIds
                  .map((id) =>
                    lifecycleLabel(
                      data.lifecycles?.lifecycles.find((l) => l.id === id),
                    ),
                  )
                  .join(" / ")}
              </p>
              {!group.canReviewWhole && (
                <p className="muted">
                  Some fills already have a decision. Use individual review for
                  the remaining fills.
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
        })}
      </ul>
      <p className="muted">
        {groups.length} selected. Include earlier related connections when
        connecting calls to the same share lifecycle.
      </p>
      {!!groups.length && !candidates.length && (
        <p className="muted">
          These connections have no common eligible share lifecycle. Choose a
          smaller selection or review them individually.
        </p>
      )}
      <div className="connection-card-actions">
        <button
          type="button"
          className="primary"
          disabled={disabled || !groups.length || !candidates.length}
          onClick={() => setMode("connect")}
        >
          Connect selected
        </button>
        <button
          type="button"
          className="secondary"
          disabled={disabled || !groups.length}
          onClick={() => setMode("separate")}
        >
          Keep selected separate
        </button>
      </div>
      {mode && (
        <Suspense fallback={<p role="status">Loading connection review…</p>}>
          <BatchConnectionDialog
            data={data}
            groups={groups}
            separate={mode === "separate"}
            onDismiss={() => {
              setMode(null);
              setSelected(new Set());
              onChanged();
            }}
          />
        </Suspense>
      )}
    </section>
  );
}

export function ConnectionQueue({
  data,
  onChanged = () => {},
}: {
  data: ConnectionData;
  onChanged?: () => void;
}) {
  const sections = connectionSections(data);
  if (!sections.length) return null;
  const groups = sections.flatMap((s) => s.groups);
  const affected = new Set(groups.flatMap((g) => g.affectedIds)).size;
  return (
    <section
      className="connection-queue"
      aria-label="Trade connections to review"
    >
      <span className="connection-eyebrow">TRADE CONNECTIONS</span>
      <h3>
        {groups.length}{" "}
        {groups.length === 1 ? "connection needs" : "connections need"} review ·
        affects {affected} lifecycles
      </h3>
      <p className="muted">
        Select connections for one underlying and resolve them together, oldest
        first.
      </p>
      {sections.map((section) => (
        <UnderlyingConnections
          key={`${data.buildId}:${section.key}`}
          section={section}
          data={data}
          onChanged={onChanged}
        />
      ))}
    </section>
  );
}

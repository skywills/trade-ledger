import { lazy, Suspense, useState } from "react";
import { ApplyRecommendedButton, ConnectionRow } from "./ConnectionRows.js";
import {
  type ConnectionData,
  type ConnectionSection,
  commonConnectionTargets,
  connectionSections,
} from "./connection-batch.js";
import {
  groupPlan,
  type PositionGroup,
  positionGroups,
} from "./connection-guidance.js";
import type { ConnectionGroup } from "./connections.js";
import "./connections.css";

const BatchConnectionDialog = lazy(() =>
  import("./BatchConnectionDialog.js").then((m) => ({
    default: m.BatchConnectionDialog,
  })),
);

const ApplyRecommendedDialog = lazy(() =>
  import("./ApplyRecommendedDialog.js").then((m) => ({
    default: m.ApplyRecommendedDialog,
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
  const [applying, setApplying] = useState<PositionGroup | null>(null);
  const [mode, setMode] = useState<"connect" | "separate" | null>(null);
  const eligible = section.groups.filter((g) => g.canReviewWhole);
  const groups = section.groups.filter((g) => selected.has(g.key));
  const allSelected =
    eligible.length > 0 && eligible.every((g) => selected.has(g.key));
  const disabled = data.stale || data.rebuildRequired || !data.buildId;
  const candidates = commonConnectionTargets(groups);
  const positions = section.groups.some(groupPlan)
    ? positionGroups(section, data)
    : null;
  const toggle = (key: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  const rows = (list: ConnectionGroup[]) => (
    <ul className="connection-selection-list">
      {list.map((group) => (
        <ConnectionRow
          key={group.key}
          group={group}
          data={data}
          checked={selected.has(group.key)}
          disabled={disabled}
          onToggle={(checked) => toggle(group.key, checked)}
        />
      ))}
    </ul>
  );
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
      {positions
        ? positions.map((position) => (
            <div
              key={position.lifecycleId ?? "choice"}
              className="connection-position"
            >
              <h5>{position.title}</h5>
              {rows(position.groups)}
              <ApplyRecommendedButton
                position={position}
                data={data}
                disabled={disabled}
                onApply={() => setApplying(position)}
              />
            </div>
          ))
        : rows(section.groups)}
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
      {applying && (
        <Suspense fallback={<p role="status">Loading connection review…</p>}>
          <ApplyRecommendedDialog
            data={data}
            position={applying}
            onDismiss={() => {
              setApplying(null);
              setSelected(new Set());
              onChanged();
            }}
          />
        </Suspense>
      )}
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
      <p className="muted">
        A share position covers one short call per 100 shares at a time. Calls
        are connected oldest first; a call sold while the shares were already
        covering another call, or kept open after the shares were sold, is kept
        separate.
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

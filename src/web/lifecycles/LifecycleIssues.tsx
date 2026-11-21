import { memo } from "react";
import { Link } from "../navigation.js";
import type { ConnectionData } from "./connection-batch.js";
import { lifecycleLabel, reviewLabel } from "./connections.js";

type Projection = NonNullable<ConnectionData["lifecycles"]>;
const allocationPrefix = "lifecycle:conservation:";
const decisionPrefix = "lifecycle:decision:";
const campaignPrefix = "lifecycle:campaign-conflict:";

function allocationStrategy(issueKey: string) {
  if (!issueKey.startsWith(allocationPrefix)) return null;
  try {
    const ref: unknown = JSON.parse(issueKey.slice(allocationPrefix.length));
    if (Array.isArray(ref) && ref.length === 3 && typeof ref[0] === "string")
      return ref[0];
  } catch {
    // Unknown retained key formats still have a visible issue reference.
  }
  return null;
}

export const LifecycleIssues = memo(function LifecycleIssues({
  projection,
  buildId,
}: {
  projection: Projection;
  buildId: string;
}) {
  const issues = projection.issues.filter(
    (i) => i.code !== "PENDING_CALL_ATTACHMENT",
  );
  if (!issues.length) return null;
  const cycles = new Map(projection.lifecycles.map((l) => [l.id, l]));
  const ownersByReference = new Map<string, Set<string>>();
  const rowKey = (s: { importId: string; rowNumber: number }) =>
    JSON.stringify([s.importId, s.rowNumber]);
  for (const issue of issues) {
    if (issue.key.startsWith(allocationPrefix))
      ownersByReference.set(issue.key, new Set());
    for (const source of issue.sources)
      ownersByReference.set(rowKey(source), new Set());
  }
  if (ownersByReference.size) {
    for (const m of projection.members) {
      const { strategyId, executionKey, role } = m.allocation;
      ownersByReference
        .get(
          allocationPrefix + JSON.stringify([strategyId, executionKey, role]),
        )
        ?.add(m.lifecycleId);
      for (const source of m.sources)
        ownersByReference.get(rowKey(source))?.add(m.lifecycleId);
    }
  }
  const expected = `?expectedBuildId=${encodeURIComponent(buildId)}`;
  return (
    <aside aria-label="Lifecycle issues">
      <h3>Needs review</h3>
      <ul>
        {issues.map((issue) => {
          const owners = new Set(
            issue.reconciliation?.owners
              .filter((o) => o.kind === "lifecycle" && cycles.has(o.id))
              .map((o) => o.id),
          );
          if (!owners.size) {
            for (const id of ownersByReference.get(issue.key) ?? [])
              owners.add(id);
            if (issue.key.startsWith(campaignPrefix))
              owners.add(issue.key.slice(campaignPrefix.length));
            for (const source of issue.sources) {
              for (const id of ownersByReference.get(rowKey(source)) ?? [])
                owners.add(id);
            }
          }
          const affected = [...owners].flatMap((id) => cycles.get(id) ?? []);
          const strategy = !affected.length && allocationStrategy(issue.key);
          const decision = issue.key.startsWith(decisionPrefix)
            ? issue.key.slice(decisionPrefix.length)
            : null;
          return (
            <li key={issue.key}>
              {reviewLabel([issue.code])}
              {affected.map((cycle) => (
                <span key={cycle.id}>
                  {" "}
                  ·{" "}
                  <Link
                    to={`/lifecycles/${encodeURIComponent(cycle.id)}${expected}`}
                  >
                    {cycle.account} ·{" "}
                    {cycle.underlyingKey.replace(/^value:/, "")} ·{" "}
                    {lifecycleLabel(cycle)}
                  </Link>
                </span>
              ))}
              {strategy && (
                <>
                  {" "}
                  ·{" "}
                  <Link
                    to={`/strategies/${encodeURIComponent(strategy)}${expected}`}
                  >
                    Strategy {strategy}
                  </Link>
                </>
              )}
              {decision && (
                <>
                  {" "}
                  ·{" "}
                  <Link
                    to={`/review?decisionId=${encodeURIComponent(decision)}`}
                  >
                    Decision {decision}
                  </Link>
                </>
              )}
              {issue.sources.map((source) => (
                <span key={rowKey(source)}>
                  {" "}
                  ·{" "}
                  <Link
                    to={`/imports?import=${encodeURIComponent(source.importId)}&row=${source.rowNumber}`}
                  >
                    Source row {source.rowNumber}
                  </Link>
                </span>
              ))}
              {!affected.length &&
                !strategy &&
                !decision &&
                !issue.sources.length && <> · {issue.key}</>}
            </li>
          );
        })}
      </ul>
    </aside>
  );
});

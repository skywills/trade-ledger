import type { z } from "zod";
import { Link } from "../navigation.js";
import type { LifecycleListSchema } from "./api.js";
import { connectionGroups, lifecycleLabel } from "./connections.js";
import "./connections.css";

export function ConnectionQueue({
  data,
}: {
  data: z.infer<typeof LifecycleListSchema>;
}) {
  const projection = data.lifecycles;
  if (!projection) return null;
  const groups = connectionGroups(
    projection.suggestions,
    projection.members,
    data.connectionExecutions,
  );
  if (!groups.length) return null;
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
        Confirm which calls belong with your share trades so their history and
        results are grouped correctly.
      </p>
      <ul>
        {groups.map((group) => {
          const owner = group.members[0]?.lifecycleId ?? group.candidateIds[0];
          return (
            <li key={group.key}>
              <strong>
                {group.underlying} · {group.contracts} short calls
              </strong>
              <p className="muted">
                {group.candidateIds
                  .map((id) =>
                    lifecycleLabel(
                      projection.lifecycles.find((l) => l.id === id),
                    ),
                  )
                  .join(" / ")}
              </p>
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
    </section>
  );
}

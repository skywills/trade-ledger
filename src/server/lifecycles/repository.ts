import type {
  LifecycleProjection,
  RetainedLifecycleAnchor,
} from "../../shared/lifecycles.js";
import type { Store } from "../storage/database.js";
/** Earlier persisted anchors take precedence over newly discovered fills. */
export function readLifecycleAnchors(
  db: Store["db"],
): RetainedLifecycleAnchor[] {
  return db
    .prepare(
      "SELECT id, account, opening_execution_key AS openingExecutionKey FROM lifecycle_identities ORDER BY rowid",
    )
    .all() as RetainedLifecycleAnchor[];
}
export function persistLifecycleProjection(
  db: Store["db"],
  buildId: string,
  p: LifecycleProjection,
): void {
  db.prepare("DELETE FROM lifecycle_projection_views WHERE build_id = ?").run(
    buildId,
  );
  db.prepare(
    "INSERT INTO lifecycle_projection_views(build_id,projection_json) VALUES (?,?)",
  ).run(
    buildId,
    JSON.stringify({
      version: p.version,
      suggestions: p.suggestions,
      issues: p.issues,
      valuations: p.valuations,
    }),
  );
  for (const l of p.lifecycles) {
    const opening = l.originOpeningExecutionKey ?? l.id;
    db.prepare(
      "INSERT OR IGNORE INTO lifecycle_identities(id,account,opening_execution_key) VALUES (?,?,?)",
    ).run(l.id, l.account, opening);
    db.prepare(
      "INSERT INTO lifecycle_views(build_id,lifecycle_id,view_json) VALUES (?,?,?)",
    ).run(buildId, l.id, JSON.stringify(l));
  }
  for (const m of p.members) {
    const row = db
      .prepare(
        `SELECT a.revision_id FROM strategy_allocations a JOIN transaction_revisions r ON r.id=a.revision_id AND r.ledger_build_id=a.ledger_build_id WHERE a.build_id=? AND a.strategy_id=? AND a.allocation_role=? AND r.logical_transaction_key=?`,
      )
      .get(
        buildId,
        m.allocation.strategyId,
        m.allocation.role,
        m.allocation.executionKey,
      ) as { revision_id: string } | undefined;
    if (!row)
      throw Error("Lifecycle source allocation is not present in this build.");
    db.prepare(
      "INSERT INTO lifecycle_member_views(build_id,lifecycle_id,strategy_id,revision_id,allocation_role,quantity,member_json) VALUES (?,?,?,?,?,?,?)",
    ).run(
      buildId,
      m.lifecycleId,
      m.allocation.strategyId,
      row.revision_id,
      m.allocation.role,
      m.quantity,
      JSON.stringify(m),
    );
  }
  for (const c of p.campaigns) {
    db.prepare("INSERT OR IGNORE INTO campaign_identities(id) VALUES (?)").run(
      c.id,
    );
    db.prepare(
      "INSERT INTO campaign_views(build_id,campaign_id,view_json) VALUES (?,?,?)",
    ).run(buildId, c.id, JSON.stringify(c));
  }
}
export function loadLifecycleProjection(
  db: Store["db"],
  buildId: string,
): LifecycleProjection | undefined {
  const row = db
    .prepare(
      "SELECT projection_json FROM lifecycle_projection_views WHERE build_id=?",
    )
    .get(buildId) as { projection_json: string } | undefined;
  if (!row) return undefined;
  const read = (sql: string) =>
    (db.prepare(sql).all(buildId) as { view_json: string }[]).map((r) =>
      JSON.parse(r.view_json),
    );
  const members = (
    db
      .prepare(
        "SELECT member_json FROM lifecycle_member_views WHERE build_id=? ORDER BY lifecycle_id,strategy_id,revision_id,allocation_role",
      )
      .all(buildId) as { member_json: string }[]
  ).map((r) => JSON.parse(r.member_json));
  return {
    ...JSON.parse(row.projection_json),
    lifecycles: read(
      "SELECT view_json FROM lifecycle_views WHERE build_id=? ORDER BY lifecycle_id",
    ),
    campaigns: read(
      "SELECT view_json FROM campaign_views WHERE build_id=? ORDER BY campaign_id",
    ),
    members,
  } as LifecycleProjection;
}

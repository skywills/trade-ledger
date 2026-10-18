CREATE TABLE lifecycle_identities (
 id TEXT PRIMARY KEY,
 account TEXT NOT NULL,
 opening_execution_key TEXT NOT NULL,
 UNIQUE(account, opening_execution_key)
);
CREATE TABLE campaign_identities (id TEXT PRIMARY KEY);
CREATE TABLE lifecycle_projection_views (
 build_id TEXT PRIMARY KEY REFERENCES builds(id) ON DELETE CASCADE,
 projection_json TEXT NOT NULL
);
CREATE TABLE lifecycle_views (
 build_id TEXT NOT NULL REFERENCES lifecycle_projection_views(build_id) ON DELETE CASCADE,
 lifecycle_id TEXT NOT NULL REFERENCES lifecycle_identities(id) ON DELETE RESTRICT,
 view_json TEXT NOT NULL,
 PRIMARY KEY(build_id,lifecycle_id)
);
CREATE TABLE lifecycle_member_views (
 build_id TEXT NOT NULL,
 lifecycle_id TEXT NOT NULL,
 strategy_id TEXT NOT NULL,
 revision_id TEXT NOT NULL,
 allocation_role TEXT NOT NULL,
 quantity TEXT NOT NULL,
 member_json TEXT NOT NULL,
 PRIMARY KEY(build_id,lifecycle_id,strategy_id,revision_id,allocation_role),
 FOREIGN KEY(build_id,lifecycle_id) REFERENCES lifecycle_views(build_id,lifecycle_id) ON DELETE CASCADE,
 FOREIGN KEY(build_id,strategy_id,revision_id,allocation_role) REFERENCES strategy_allocations(build_id,strategy_id,revision_id,allocation_role) ON DELETE CASCADE
);
CREATE TABLE campaign_views (
 build_id TEXT NOT NULL REFERENCES lifecycle_projection_views(build_id) ON DELETE CASCADE,
 campaign_id TEXT NOT NULL REFERENCES campaign_identities(id) ON DELETE RESTRICT,
 view_json TEXT NOT NULL,
 PRIMARY KEY(build_id,campaign_id)
);

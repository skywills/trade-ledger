CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  broker_account_id TEXT NOT NULL UNIQUE,
  base_currency TEXT
);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  original_file_path TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  report_period TEXT,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL,
  capability_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS imports_sha256_idx ON imports(sha256);

CREATE TABLE IF NOT EXISTS import_rows (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(id) ON DELETE RESTRICT,
  row_number INTEGER NOT NULL CHECK(row_number > 0),
  section TEXT,
  raw_fields_json TEXT NOT NULL,
  row_kind TEXT NOT NULL,
  parse_errors_json TEXT NOT NULL,
  UNIQUE(import_id, row_number)
);
CREATE INDEX IF NOT EXISTS import_rows_import_idx ON import_rows(import_id, row_number);

CREATE TABLE IF NOT EXISTS ledger_builds (
  id TEXT PRIMARY KEY,
  input_manifest_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transaction_revisions (
  id TEXT PRIMARY KEY,
  ledger_build_id TEXT NOT NULL REFERENCES ledger_builds(id) ON DELETE RESTRICT,
  logical_transaction_key TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  instrument_json TEXT NOT NULL,
  broker_ids_json TEXT NOT NULL,
  trade_id TEXT,
  execution_id TEXT,
  order_id TEXT,
  brokerage_order_id TEXT,
  position_action_id TEXT,
  event_type TEXT NOT NULL,
  original_datetime TEXT,
  timezone TEXT,
  signed_quantity TEXT NOT NULL,
  price TEXT,
  currency TEXT NOT NULL,
  net_cash TEXT,
  proceeds TEXT,
  commission TEXT,
  taxes TEXT,
  basis TEXT,
  broker_pnl TEXT,
  action TEXT,
  revision_state TEXT NOT NULL,
  UNIQUE(ledger_build_id, logical_transaction_key, revision_number),
  UNIQUE(ledger_build_id, id)
);
CREATE INDEX IF NOT EXISTS transaction_revisions_trade_id_idx
  ON transaction_revisions(account_id, trade_id);
CREATE INDEX IF NOT EXISTS transaction_revisions_execution_id_idx
  ON transaction_revisions(account_id, execution_id);
CREATE INDEX IF NOT EXISTS transaction_revisions_order_id_idx
  ON transaction_revisions(account_id, order_id);
CREATE INDEX IF NOT EXISTS transaction_revisions_brokerage_order_id_idx
  ON transaction_revisions(account_id, brokerage_order_id);
CREATE INDEX IF NOT EXISTS transaction_revisions_position_action_id_idx
  ON transaction_revisions(account_id, position_action_id);
CREATE INDEX IF NOT EXISTS transaction_revisions_ledger_idx
  ON transaction_revisions(ledger_build_id, logical_transaction_key);

CREATE TABLE IF NOT EXISTS transaction_sources (
  ledger_build_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  import_row_id TEXT NOT NULL REFERENCES import_rows(id) ON DELETE RESTRICT,
  PRIMARY KEY(ledger_build_id, revision_id, import_row_id),
  FOREIGN KEY(ledger_build_id, revision_id)
    REFERENCES transaction_revisions(ledger_build_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS transaction_sources_row_idx ON transaction_sources(import_row_id);

CREATE TABLE IF NOT EXISTS lot_details (
  id TEXT PRIMARY KEY,
  ledger_build_id TEXT NOT NULL REFERENCES ledger_builds(id) ON DELETE RESTRICT,
  import_row_id TEXT NOT NULL REFERENCES import_rows(id) ON DELETE RESTRICT,
  closing_reference TEXT,
  opening_datetime TEXT,
  signed_lot_quantity TEXT NOT NULL,
  basis TEXT,
  reported_pnl TEXT,
  UNIQUE(ledger_build_id, import_row_id, closing_reference)
);

CREATE TABLE IF NOT EXISTS strategy_identities (
  id TEXT PRIMARY KEY,
  stable_anchor_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE CHECK(sequence > 0),
  kind TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  strategy_ids_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  author TEXT NOT NULL,
  supersedes_id TEXT REFERENCES decisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK(supersedes_id IS NULL OR supersedes_id <> id)
);
CREATE INDEX IF NOT EXISTS decisions_kind_sequence_idx ON decisions(kind, sequence);

CREATE TABLE IF NOT EXISTS identity_bindings (
  id TEXT PRIMARY KEY,
  source_reference_json TEXT NOT NULL,
  logical_reference TEXT NOT NULL,
  canonical_identity_id TEXT NOT NULL REFERENCES strategy_identities(id) ON DELETE RESTRICT,
  decision_id TEXT REFERENCES decisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_bindings_logical_idx ON identity_bindings(logical_reference);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  input_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  progress TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS llm_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('local', 'cloud')),
  provider_adapter TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT,
  model_id TEXT NOT NULL,
  context_limit INTEGER,
  output_limit INTEGER,
  capabilities_json TEXT NOT NULL,
  credential_reference TEXT,
  timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  UNIQUE(name, revision)
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  input_references_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  profile_id TEXT REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  profile_snapshot_json TEXT NOT NULL,
  requested_model TEXT,
  returned_model TEXT,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  decision_references_json TEXT NOT NULL,
  usage_json TEXT,
  cost TEXT,
  cost_source TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_runs_input_idx ON ai_runs(input_hash, created_at);

CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  ledger_build_id TEXT NOT NULL REFERENCES ledger_builds(id) ON DELETE RESTRICT,
  decision_watermark INTEGER NOT NULL CHECK(decision_watermark >= 0),
  algorithm_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  UNIQUE(id, ledger_build_id)
);
CREATE INDEX IF NOT EXISTS builds_ledger_status_idx ON builds(ledger_build_id, status);

CREATE TABLE IF NOT EXISTS strategy_views (
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  strategy_id TEXT NOT NULL REFERENCES strategy_identities(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL,
  opening_date TEXT,
  close_date TEXT,
  expiry TEXT,
  expiry_year INTEGER,
  status TEXT NOT NULL,
  history_complete INTEGER NOT NULL DEFAULT 0 CHECK(history_complete IN (0, 1)),
  opening_amount TEXT,
  realized_pnl TEXT,
  remaining_exposure TEXT,
  PRIMARY KEY(build_id, strategy_id)
);
CREATE INDEX IF NOT EXISTS strategy_views_filter_idx
  ON strategy_views(build_id, status, currency, type, opening_date, close_date, expiry_year);

CREATE TABLE IF NOT EXISTS strategy_allocations (
  build_id TEXT NOT NULL,
  ledger_build_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  allocation_role TEXT NOT NULL,
  allocated_quantity TEXT NOT NULL,
  allocated_cash TEXT,
  PRIMARY KEY(build_id, strategy_id, revision_id, allocation_role),
  FOREIGN KEY(build_id, ledger_build_id)
    REFERENCES builds(id, ledger_build_id) ON DELETE CASCADE,
  FOREIGN KEY(build_id, strategy_id)
    REFERENCES strategy_views(build_id, strategy_id) ON DELETE CASCADE,
  FOREIGN KEY(ledger_build_id, revision_id)
    REFERENCES transaction_revisions(ledger_build_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS strategy_allocations_revision_idx
  ON strategy_allocations(ledger_build_id, revision_id);

CREATE TABLE IF NOT EXISTS strategy_links (
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  source_strategy_id TEXT NOT NULL,
  target_strategy_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  event_reference_json TEXT NOT NULL,
  source_references_json TEXT NOT NULL,
  PRIMARY KEY(build_id, source_strategy_id, target_strategy_id, link_type),
  FOREIGN KEY(build_id, source_strategy_id)
    REFERENCES strategy_views(build_id, strategy_id) ON DELETE CASCADE,
  FOREIGN KEY(build_id, target_strategy_id)
    REFERENCES strategy_views(build_id, strategy_id) ON DELETE CASCADE,
  CHECK(source_strategy_id <> target_strategy_id)
);

CREATE TABLE IF NOT EXISTS position_views (
  build_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  instrument_key TEXT NOT NULL,
  remaining_quantity TEXT NOT NULL,
  basis TEXT,
  completeness TEXT NOT NULL,
  PRIMARY KEY(build_id, strategy_id, instrument_key),
  FOREIGN KEY(build_id, strategy_id)
    REFERENCES strategy_views(build_id, strategy_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_items (
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  stable_issue_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_references_json TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  PRIMARY KEY(build_id, stable_issue_key)
);

CREATE TABLE IF NOT EXISTS import_previews (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS import_previews_expiry_idx ON import_previews(expires_at);

CREATE TABLE IF NOT EXISTS profile_checks (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  profile_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  duration_ms INTEGER,
  result_json TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS profile_checks_profile_idx ON profile_checks(profile_id, checked_at);

CREATE TABLE IF NOT EXISTS app_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  active_build_id TEXT REFERENCES builds(id) ON DELETE RESTRICT,
  default_profile_id TEXT REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO app_state(singleton, updated_at) VALUES (1, CURRENT_TIMESTAMP);

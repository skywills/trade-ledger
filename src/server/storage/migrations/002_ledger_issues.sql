CREATE TABLE IF NOT EXISTS ledger_issues (
  ledger_build_id TEXT NOT NULL REFERENCES ledger_builds(id) ON DELETE RESTRICT,
  stable_issue_key TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  PRIMARY KEY(ledger_build_id, stable_issue_key)
);
CREATE INDEX IF NOT EXISTS ledger_issues_code_idx ON ledger_issues(ledger_build_id, code);

ALTER TABLE transaction_revisions ADD COLUMN codes_json TEXT NOT NULL DEFAULT '[]';

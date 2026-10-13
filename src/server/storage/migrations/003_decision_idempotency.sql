ALTER TABLE decisions ADD COLUMN client_request_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS decisions_client_request_id_idx
  ON decisions(client_request_id)
  WHERE client_request_id <> '';

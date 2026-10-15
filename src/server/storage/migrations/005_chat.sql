-- src/server/storage/migrations/005_chat.sql
CREATE TABLE IF NOT EXISTS chat_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  profile_id TEXT REFERENCES llm_profiles(id) ON DELETE RESTRICT,
  model_ref TEXT NOT NULL,
  cloud_confirmed INTEGER NOT NULL CHECK(cloud_confirmed IN (0, 1)),
  status TEXT NOT NULL,
  pending_json TEXT,
  seed_json TEXT,
  usage_json TEXT NOT NULL,
  cost TEXT NOT NULL,
  next_seq INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_threads_updated_idx ON chat_threads(updated_at);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  attachments_json TEXT,
  tools_json TEXT,
  status TEXT NOT NULL,
  error TEXT,
  usage_json TEXT,
  cost TEXT,
  client_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(thread_id, seq),
  UNIQUE(thread_id, client_message_id)
);
ALTER TABLE ai_runs ADD COLUMN thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL;

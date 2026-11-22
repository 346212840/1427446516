-- Call the owner and Request a call (calls_owner_reach). The owner's
-- availability switch, and call requests waiting for Accept, Suggest
-- another time or Decline. Only hashes of the IP and device are kept.

CREATE TABLE IF NOT EXISTS call_reach (
  owner_id TEXT PRIMARY KEY,
  available INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS call_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  visitor_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  zone TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  suggested_at INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  schedule_id TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  device_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_requests_token ON call_requests(token_hash);

CREATE INDEX IF NOT EXISTS idx_call_requests_owner ON call_requests(owner_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_call_requests_source ON call_requests(source_hash, state);

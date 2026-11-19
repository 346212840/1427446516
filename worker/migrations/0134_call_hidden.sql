CREATE TABLE IF NOT EXISTS call_hidden (
  public_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  hidden_at INTEGER NOT NULL,
  PRIMARY KEY (public_id, call_id)
);

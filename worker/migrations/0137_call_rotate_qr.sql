-- Short-lived rotating QR tokens. Scanning one rings the host like
-- an incoming call. A new code is issued every two minutes; the
-- previous code stays valid until it expires so a mid-scan still works.

CREATE TABLE IF NOT EXISTS call_rotate_qr (
  token_hash TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_rotate_qr_owner ON call_rotate_qr(public_id, expires_at);

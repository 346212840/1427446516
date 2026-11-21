-- Per-user titles, notes, and transcript lines for call history.
-- A rename or a note is only for this account. The other person keeps theirs.

CREATE TABLE IF NOT EXISTS call_history_meta (
  public_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (public_id, call_id)
);

CREATE TABLE IF NOT EXISTS call_transcripts (
  public_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  who TEXT NOT NULL DEFAULT '',
  mine INTEGER NOT NULL DEFAULT 0,
  original TEXT NOT NULL DEFAULT '',
  translation TEXT NOT NULL DEFAULT '',
  corrected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (public_id, call_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_call_transcripts_call ON call_transcripts(public_id, call_id, at);
